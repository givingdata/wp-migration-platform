// Slack → site edits: what happens after slack.js has checked and acknowledged a request.
//
//   message in an allowed channel, from staff → 👀 on the message and "Working on it…" in a
//   thread, updated as Claude drafts a change (slack-edits.js) → the thread shows before/after
//   with Approve / Cancel, and the 👀 goes
//   Approve (staff only) → "Publishing…" → the Edit module commits it → the site rebuilds
//
// Progress messages and reactions are best effort: a failure there (e.g. the app lacks the
// reactions:write scope) never stops the change itself.
//
// When the bot asks a question instead of drafting, it remembers the request (KV, a day) so the
// answer carries it: a reply in that thread, or the same person's next channel message within
// ASK_FOLLOWUP_SECONDS. Other thread replies are ignored, so staff can talk in threads.
//
// Nothing publishes without an Approve click, and Slack can't delete, change the menu or
// settings. Commits carry the Slack user's email, like the staff form's.
import { postMessage, updateMessage, slackApi, userEmail } from "./slack.js";
import { channelAllowed, isStaff, takeRateLimit } from "./slack-access.js";
import { proposeEdit, applyProposal, cancelProposal, getProposal, proposalBlocks, resultBlocks, APPROVE_ACTION, CANCEL_ACTION } from "./slack-edits.js";

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

async function saveQuestion(env, { channel, user, thread, request, question }) {
  if (!env.CONTENT) return;
  await env.CONTENT.put(askKey(channel, thread), JSON.stringify({ request, question }), { expirationTtl: ASK_TTL });
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

/** @param {() => object} getEditor */
export function slackHandlers(env, getEditor) {
  return {
    async onMessage({ channel, user, text, ts, threadTs }) {
      if (!channelAllowed(env, channel)) return;
      const asked = await takeQuestion(env, { channel, user, threadTs });
      if (threadTs && !asked) return; // a thread conversation, not an answer to the bot
      const thread = threadTs || ts;
      const reply = (message) => postMessage(env, { channel, threadTs: thread, text: message });
      const request = asked ? withAnswer(asked, text) : text;

      const email = await userEmail(env, user);
      if (!isStaff(env, email)) return void (await reply("Only staff can request website changes here."));
      const rate = await takeRateLimit(env, user);
      if (!rate.ok) return void (await reply(`You've reached ${rate.limit} requests this hour. Try again later.`));

      await quietly(slackApi(env, "reactions.add", { channel, timestamp: ts, name: "eyes" }));
      const working = await reply("Working on it… reading the site (this can take up to a minute).");
      const progress = (message) => quietly(updateMessage(env, { channel, ts: working, text: message }));
      try {
        const result = await proposeEdit(env, getEditor(), { text: request, by: email, requestedBy: user, progress });
        const view = result.kind === "proposal" ? proposalBlocks(result.proposal, { siteUrl: siteUrl(env) }) : { text: result.text };
        await updateMessage(env, { channel, ts: working, ...view });
        if (result.kind === "reply") await quietly(saveQuestion(env, { channel, user, thread, request, question: result.text }));
      } catch (e) {
        console.error("Slack draft failed", e.message);
        await updateMessage(env, { channel, ts: working, text: `⚠️ Couldn't draft that change: ${friendly(e)}` });
      } finally {
        await quietly(slackApi(env, "reactions.remove", { channel, timestamp: ts, name: "eyes" }));
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

      await quietly(slackApi(env, "chat.postEphemeral", { channel, user, text: "Publishing… this takes a few seconds." }));
      try {
        const { proposal, path } = await applyProposal(env, getEditor(), value, { by: email });
        await show(resultBlocks(proposal, { status: "applied", by: email, siteUrl: siteUrl(env), path }));
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
