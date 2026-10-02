// Slack → site edits: what happens after slack.js has checked and acknowledged a request.
//
//   message in an allowed channel, from staff → 👀 on the message and "Working on it…" in a
//   thread, updated as Claude drafts a change (slack-edits.js) → the thread shows before/after
//   with Approve / Cancel, and the 👀 goes
//   Approve (staff only) → "Publishing…" → the Edit module commits it → "Going live in a few
//   minutes…" → the site rebuilds and its workflow reports back (deploys.js) → "🟢 Live" or ⚠️
//
// Progress messages and reactions are best effort: a failure there (e.g. the app lacks the
// reactions:write scope) never stops the change itself.
//
// When the bot asks a question instead of drafting, it remembers the request (KV, a day) so the
// answer carries it: a reply in that thread, or the same person's next channel message within
// ASK_FOLLOWUP_SECONDS. Other thread replies are ignored, so staff can talk in threads, except
// "#3: …" or "skip #3" under a photo descriptions card, which changes it (photo-descriptions.js).
//
// A photo posted with (or as) a request is downloaded after the staff check, shown to Claude as
// a small copy, and stored like a staff-form upload once Claude has picked where it goes. The
// remembered question keeps the photo, so "which page is this for?" can be answered in the thread.
//
// A request deleted by its author takes the bot's thread with it: the bot deletes its own replies
// there (people can't delete an app's messages), cancels a proposal still waiting for Approve and
// forgets an open question. A change already published stays live; git keeps its history.
//
// A change for later ("Friday at 9") is approved the same way; Approve then schedules it, the
// message says when (with a Cancel button), and onTick (the router's cron, every 10 minutes)
// publishes it and updates that message like an Approve would. The same tick posts the monthly
// check-up (checkup.js) once a month.
//
// Nothing publishes without an Approve click. Slack can remove an entry only to the trash (and
// put it back, or undo a recent change), and can't change the menu or settings. Commits carry the Slack user's email, like the staff form's.
import specs from "../../config/design-specs.json" with { type: "json" };
import { postMessage, updateMessage, slackApi, userEmail, downloadFile, IMAGE_TYPES, MAX_FILE_BYTES } from "./slack.js";
import { storeImage, previewForClaude } from "./cloudflare.js";
import { fetchImageLink, findLinkedImage } from "./linked-page.js";
import { channelAllowed, isStaff, takeRateLimit } from "./slack-access.js";
import { rememberDeploy } from "./deploys.js";
import { runCheckup } from "./checkup.js";
import {
  proposeEdit, applyProposal, cancelProposal, scheduleProposal, takeDue, getProposal, proposalBlocks, resultBlocks, APPROVE_ACTION, CANCEL_ACTION,
} from "./slack-edits.js";
import { rememberCard, reviseFromThread } from "./photo-descriptions.js";

const siteUrl = (env) => env.SITE_URL || null;

const ASK_TTL = 86_400;
const ASK_FOLLOWUP_SECONDS = 600;
const askKey = (channel, thread) => `slack:ask:${channel}:${thread}`;
const askUserKey = (channel, user) => `slack:ask-user:${channel}:${user}`;

// The open question for a thread (or this person's latest), removed once read so it's answered once.
async function takeQuestion(env, { channel, user, threadTs }) {
  if (!env.CONTENT) return null;
  const thread = threadTs || (await env.CONTENT.get(askUserKey(channel, user)));
  if (!thread) return null;
  const raw = await env.CONTENT.get(askKey(channel, thread));
  if (!raw) return null;
  await Promise.all([env.CONTENT.delete?.(askKey(channel, thread)), env.CONTENT.delete?.(askUserKey(channel, user))]);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveQuestion(env, { channel, user, thread, request, question, photo }) {
  if (!env.CONTENT) return;
  await env.CONTENT.put(askKey(channel, thread), JSON.stringify({ request, question, ...(photo ? { photo } : {}) }), { expirationTtl: ASK_TTL });
  await env.CONTENT.put(askUserKey(channel, user), thread, { expirationTtl: ASK_FOLLOWUP_SECONDS });
}

// The request Claude sees for an answer: the original, what the bot asked, and the reply.
const withAnswer = (asked, answer) =>
  `${asked.request}\n\n(You asked: "${asked.question}")\nTheir answer: ${answer}\n` +
  "If the answer is really a new, unrelated request, handle that request instead.";

// Slack calls that only show progress: log and carry on if they fail.
const quietly = (p) => p.catch((e) => console.error("slack progress:", e?.message || e));

function friendly(e) {
  return e?.status && e.status < 500 ? e.message : "Something went wrong on our side. Try again in a minute, or use the staff form.";
}

const TYPE_NAMES = IMAGE_TYPES.map((t) => t.split("/")[1].toUpperCase().replace("JPEG", "JPG")).join(", ");

// Why a photo couldn't be used, in words staff can act on (download errors come from slack.js / the router).
function photoProblem(e) {
  const code = String(e?.message || "");
  if (/missing_scope/.test(code)) return "I can't open photos yet: the Slack app needs permission to read files. Ask your web team.";
  if (/unsupported_type|not_an_image/.test(code)) return `I can only use photos (${TYPE_NAMES}).`;
  if (/too_large/.test(code)) return `That photo is too big; the limit is ${MAX_FILE_BYTES / 1048576} MB.`;
  if (/not_your_file|file_not_found|bad_file/.test(code)) return "I couldn't find that photo any more. Please post it again.";
  if (/link_failed/.test(code)) return "I couldn't download the image at that link any more. Please post the link again, or upload the photo.";
  return "I couldn't download that photo. Please try posting it again.";
}

// Check what was posted: nothing, one usable photo, or a reason to say no.
function pickPhoto(files) {
  if (!files?.length) return { photo: null };
  const photos = files.filter((f) => IMAGE_TYPES.includes(f.mimetype));
  if (!photos.length) return { problem: `I can only use photos (${TYPE_NAMES}), not other files.` };
  if (photos.length > 1) return { problem: "Please post one photo at a time, with a message saying where it goes." };
  if (photos[0].size > MAX_FILE_BYTES) return { problem: `That photo is too big; the limit is ${MAX_FILE_BYTES / 1048576} MB.` };
  return { photo: photos[0] };
}

// The proposal ids on a bot message's Approve / Cancel buttons.
function proposalIds(message) {
  const ids = new Set();
  for (const block of message.blocks || []) {
    for (const el of block.type === "actions" ? block.elements || [] : []) {
      if ([APPROVE_ACTION, CANCEL_ACTION].includes(el.action_id) && typeof el.value === "string") ids.add(el.value);
    }
  }
  return [...ids];
}

/** @param {() => object} getEditor */
export function slackHandlers(env, getEditor) {
  return {
    async onMessage({ channel, user, text, ts, threadTs, files }) {
      if (!channelAllowed(env, channel)) return;
      const asked = await takeQuestion(env, { channel, user, threadTs });
      // A thread conversation, not an answer to the bot (unless it changes a photo descriptions card).
      if (threadTs && !asked) return void (await quietly(reviseFromThread(env, { channel, user, text, threadTs })));
      const thread = threadTs || ts;
      const reply = (message) => postMessage(env, { channel, threadTs: thread, text: message });
      const request = asked ? withAnswer(asked, text) : text;

      const email = await userEmail(env, user);
      if (!isStaff(env, email)) return void (await reply("Only staff can request website changes here."));
      const picked = pickPhoto(files);
      if (picked.problem) return void (await reply(picked.problem));
      // A new photo wins; otherwise an answer keeps the photo from the question it answers.
      // A link to an image (from the web or the site) counts as a photo when none is posted.
      let photo = picked.photo ?? asked?.photo ?? null;
      const rate = await takeRateLimit(env, user);
      if (!rate.ok) return void (await reply(`You've reached ${rate.limit} requests this hour. Try again later.`));

      await quietly(slackApi(env, "reactions.add", { channel, timestamp: ts, name: "eyes" }));
      const working = await reply("Working on it… reading the site (this can take up to a minute).");
      const progress = (message) => quietly(updateMessage(env, { channel, ts: working, text: message }));
      try {
        let image, store, file;
        try {
          if (photo?.link) {
            file = await fetchImageLink(photo.link);
            if (!file) throw new Error("link_failed");
          } else if (photo) file = await downloadFile(env, photo);
          else if ((file = await findLinkedImage(request))) photo = { link: file.url, name: file.name };
        } catch (e) {
          console.error("Slack photo download failed", e.message);
          return void (await updateMessage(env, { channel, ts: working, text: `⚠️ ${photoProblem(e)}` }));
        }
        if (file) {
          image = { name: file.name, ...(photo.link ? { url: photo.link } : {}), preview: await previewForClaude(env, file.bytes, file.type) };
          const upload = new File([file.bytes], file.name, { type: file.type });
          store = (typeSpec, contentId) => storeImage(env, specs, typeSpec, `slack-${contentId}`, upload);
        }
        const result = await proposeEdit(env, getEditor(), { text: request, by: email, requestedBy: user, progress, image, storeImage: store });
        const view = result.kind === "proposal" ? proposalBlocks(result.proposal, { siteUrl: siteUrl(env) }) : { text: result.text };
        await updateMessage(env, { channel, ts: working, ...view });
        if (result.kind === "proposal" && result.proposal.descriptions) await quietly(rememberCard(env, { channel, thread, ts: working, proposalId: result.proposal.id }));
        if (result.kind === "reply") await quietly(saveQuestion(env, { channel, user, thread, request, question: result.text, photo }));
      } catch (e) {
        console.error("Slack draft failed", e.message);
        await updateMessage(env, { channel, ts: working, text: `⚠️ Couldn't draft that change: ${friendly(e)}` });
      } finally {
        await quietly(slackApi(env, "reactions.remove", { channel, timestamp: ts, name: "eyes" }));
      }
    },

    async onDeleted({ channel, ts }) {
      if (!channelAllowed(env, channel)) return;
      await quietly(env.CONTENT?.delete?.(askKey(channel, ts)) ?? Promise.resolve());
      const data = await slackApi(env, "conversations.replies", { channel, ts, limit: 200 });
      const replies = (data?.messages || []).filter((m) => m.ts !== ts && m.bot_id);
      for (const m of replies) {
        // A proposal still waiting for Approve can't be published from a deleted thread.
        for (const id of proposalIds(m)) {
          const proposal = await getProposal(env, id);
          if (proposal?.status === "pending") await cancelProposal(env, id, { by: "request deleted" }).catch(() => {});
        }
        // Slack refuses other apps' messages (cant_delete_message); that's fine.
        await quietly(slackApi(env, "chat.delete", { channel, ts: m.ts }));
      }
    },

    // The router's cron: scheduled changes first, then the monthly check-up when it's due (checkup.js).
    async onTick() {
      try {
        return await runScheduled(env, getEditor);
      } finally {
        await runCheckup(env, getEditor).catch((e) => console.error("Monthly check-up failed", e?.message || e));
      }
    },

    async onAction({ actionId, value, user, channel, messageTs }) {
      if (![APPROVE_ACTION, CANCEL_ACTION].includes(actionId) || !channelAllowed(env, channel)) return;
      const email = await userEmail(env, user);
      if (!isStaff(env, email)) {
        await slackApi(env, "chat.postEphemeral", { channel, user, text: "Only staff can approve or cancel website changes." });
        return;
      }
      const show = (view) => updateMessage(env, { channel, ts: messageTs, ...view });

      if (actionId === CANCEL_ACTION) {
        try {
          const { proposal } = await cancelProposal(env, value, { by: email });
          await show(resultBlocks(proposal, { status: "cancelled", by: email }));
        } catch (e) {
          await slackApi(env, "chat.postEphemeral", { channel, user, text: friendly(e) });
        }
        return;
      }

      const waiting = await getProposal(env, value);
      if (waiting?.status === "pending" && waiting.runAt && Date.parse(waiting.runAt) > Date.now()) {
        try {
          const { proposal } = await scheduleProposal(env, value, { by: email, channel, messageTs });
          await show(resultBlocks(proposal, { status: "scheduled", by: email }));
        } catch (e) {
          await slackApi(env, "chat.postEphemeral", { channel, user, text: friendly(e) });
        }
        return;
      }

      await quietly(slackApi(env, "chat.postEphemeral", { channel, user, text: "Publishing… this takes a few seconds." }));
      try {
        const { proposal, path } = await applyProposal(env, getEditor(), value, { by: email });
        await show(resultBlocks(proposal, { status: "applied", by: email, siteUrl: siteUrl(env), path }));
        await quietly(rememberDeploy(env, { sha: proposal.commitSha, channel, messageTs, proposalId: proposal.id }));
      } catch (e) {
        console.error("Slack apply failed", e.message);
        // Already approved or cancelled (double click, or another person): leave the message as it is.
        const proposal = await getProposal(env, value);
        if (proposal && proposal.status === "failed") await show(resultBlocks(proposal, { status: "failed", by: email, error: friendly(e) }));
        else await slackApi(env, "chat.postEphemeral", { channel, user, text: friendly(e) });
      }
    },
  };
}

/** Publish scheduled changes whose time has come (the router's cron calls this every 10 minutes). */
export async function runScheduled(env, getEditor, now = Date.now()) {
  const ids = await takeDue(env, now);
  for (const id of ids) {
    const waiting = await getProposal(env, id);
    if (waiting?.status !== "scheduled") continue; // cancelled meanwhile
    const where = { channel: waiting.channel, ts: waiting.messageTs };
    const show = (view) => (where.channel && where.ts ? quietly(updateMessage(env, { ...where, ...view })) : Promise.resolve());
    try {
      const { proposal, path } = await applyProposal(env, getEditor(), id, { scheduled: true });
      await show(resultBlocks(proposal, { status: "applied", siteUrl: siteUrl(env), path }));
      if (where.channel && where.ts) await quietly(rememberDeploy(env, { sha: proposal.commitSha, channel: where.channel, messageTs: where.ts, proposalId: proposal.id }));
    } catch (e) {
      console.error("Scheduled change failed", e.message);
      const proposal = await getProposal(env, id);
      if (proposal) await show(resultBlocks(proposal, { status: "failed", error: `The scheduled change didn't go live: ${friendly(e)}` }));
    }
  }
  return ids.length;
}

/** The site deploy that includes an approved Slack change finished: update its message. */
export async function onSiteDeployed(env, { channel, messageTs, proposalId }, status) {
  const proposal = await getProposal(env, proposalId);
  if (!proposal) return;
  const view = resultBlocks(proposal, { status: status === "live" ? "live" : "deployFailed", siteUrl: siteUrl(env) });
  await updateMessage(env, { channel, ts: messageTs, ...view });
}
