# SiteFlo features

What SiteFlo does, for tracking and for marketing. Keep it current: when a feature ships (or
changes what staff can say), update this file in the same commit, then the shared copy, the
**SiteFlo Features** doc (https://claude.ai/code/artifact/400e7856-790d-4830-9d1f-90f9025fc99a).
Benefit lines are written to be lifted into marketing copy as they are. Only "Live" features
may be promised to customers.

SiteFlo moves an organisation's website off WordPress onto a fast, secure, low-maintenance site
that staff update by asking in Slack. Every change is approved before it goes live and can be
undone.

## At a glance

| Area | What customers get | Status |
| --- | --- | --- |
| Edit from Slack | Ask for a change in plain words; approve it with one button | Live |
| Site health | On-demand site check plus a monthly check-up in Slack | Live |
| Google and sharing | Search previews, search titles and descriptions, share images, photo descriptions | Live |
| Staff form | A web form for staff who prefer forms to chat | Live |
| Design | Six style presets, 13 page section types, parallax photos | Live |
| Moving off WordPress | Pages, posts, menu, images and documents brought across; old links keep working | Live |
| Hosting and security | Global hosting, security headers, locked staff tools, every change reversible | Live |
| Visitor numbers in Slack | "How many visits last week?" | Live where analytics is set up |

## Edit your site from Slack

Staff post a request in their Slack channel and the SiteFlo bot drafts the change. It shows a
before-and-after with **Approve** and **Cancel** buttons; nothing changes until someone approves,
and the bot reports when the change is live, usually within a few minutes. Details: `docs/SLACK.md`.

| Feature | What staff say or do | Benefit line |
| --- | --- | --- |
| Change text | "Change the Contact page hours to 9 to 5" | Update any page, news item or event in a sentence |
| Designed pages | "Change the homepage heading to …" | Edit the words on designed pages without breaking the layout |
| Add news, events, pages | "Post this as news" + pasted text or a link | Turn an email, newsletter or web page into a post |
| Photos | Post a photo, or paste a link to an image (from the web or already on the site): "use this on the Gala event" | New photos in seconds, resized automatically |
| Change everywhere | "Our phone number is now 604-555-0199" | Fix a detail on every page at once |
| Menu links | "Add Volunteer under About" | Keep the menu current without a developer |
| Remove and undo | "Take down the Spring Gala", "undo that" | Nothing is ever lost: removed items can be put back |
| Old addresses | "Send /summer-camp to the Programs page" | Printed flyers and old links keep working |
| Scheduling | "Post this on Friday at 0900" or "Post this on Friday at 09:00 AM" | Set changes to go live later |
| Questions | "Is anything out of date?", "How many visits last week?" | Answers about the site without logging in anywhere |

If a request is unclear, the bot asks a question instead of guessing. Only listed staff in listed
channels can use it, and each person can make up to 20 requests an hour.

## Keep the site healthy

SiteFlo watches for the slow decay every website suffers: old news, past dates, broken links and
missing descriptions. Each problem comes with the exact words to ask the bot to fix it.

| Feature | How it works | Benefit line |
| --- | --- | --- |
| Site check | Ask "is anything out of date?" in Slack | A full check of the site in under a minute |
| What it finds | Stale news and events, old years, placeholder text, broken links, photos without descriptions, search titles and descriptions that are missing, too long or repeated | Catches what visitors and Google notice first |
| Monthly check-up | Posted in the channel on the first weekday of the month, only when three or more things need attention | A gentle nudge, never noise |
| Automatic tidy-up | Announcements expire and events move to "past" on their own; the site refreshes itself early each morning (around 5 a.m. Pacific) when a date passes | The site stays current without anyone remembering |

## Get found on Google

Staff can see and change how every page appears in Google and in shared links, in plain
language, with no jargon or plugins.

| Feature | What staff say or do | Benefit line |
| --- | --- | --- |
| Google preview | "How does the About page look on Google?" | See exactly what searchers see, with warnings for titles and descriptions that get cut off or repeat |
| Search title and description | "Make the search description for About mention free prom dresses" | Better search results without touching code |
| Share image | Post a photo or an image link: "use this as the share image for Events" | Control the picture shown when a page is shared on social media |
| Photo descriptions | "Describe the photos on the About page" | AI writes a description for every photo missing one, a page at a time, for staff to approve |
| View and correct descriptions | "Show the photo descriptions on About", "change photo 2's description to …", "rewrite the photo descriptions on About" | Check and fix what screen readers and Google read |
| Built-in search basics | Sitemap, structured data, clean addresses, redirects from every old WordPress address | Keeps the search rankings the old site earned |

Photo descriptions also make the site usable for people who rely on screen readers, which many
funders and public bodies now expect.

## Staff form

For staff who prefer a form to a chat, the same edits are available on a private web page that
only invited staff can open.

- **Add** news, events, announcements and pages; AI tidies the text and photos are resized automatically.
- **Edit existing** pages and entries, including the words, links and pictures on designed pages.
- **Menu** editor for the links inside dropdowns (the top menu bar stays fixed to protect the design).
- **Delete safely**: deleted items go to a trash and can be put back.
- **How it looks on Google**: search title and description fields on every page.

Every save is recorded with who made it, and any change can be rolled back.

## Design and page sections

Each site starts from a style preset in the client's own logo, colours and fonts, and its key
pages are built from ready-made sections that work on any screen.

| Feature | Detail | Benefit line |
| --- | --- | --- |
| Style presets | Classic, Community, Editorial, Modern, Bistro, Minimal | A professional look in your brand, from day one |
| Page sections | Hero, figures, text and image, cards, quote, stories, text, latest news or events, menu or price list, features, photo tiles, photo scenes, call to action | Pages that look designed, not templated |
| Parallax photos | Hero photos and photo scenes scroll more slowly than the text: subtle, medium or strong | Depth and movement that turns off for visitors who prefer less motion |
| Photo scenes | Full-width photos with a text card over each | Tell a story in pictures |
| Phone-friendly | Every section adapts to small screens | Looks right on every device |
| Custom design | A designer can hand over a design in a set format (`docs/DESIGN_HANDOFF.md`) | Room to grow into a fully bespoke look |

See it live at https://demo.flomysite.com, a fictional café built on SiteFlo.

## Moving off WordPress

SiteFlo brings an existing WordPress site across in one pass, so nothing has to be retyped.

- **Content**: every page and post, the homepage, and the menu with its dropdowns.
- **Images and documents**: every photo size, galleries (including NextGEN), and PDFs, moved to fast storage.
- **Old links**: every old address, including WordPress page numbers and image links, sends visitors to the right page. On the first client site, 90 of 90 old addresses worked.
- **Search titles and descriptions** already set in WordPress (Yoast or All in One SEO) carry over.
- **Free preview**: prospects can see their own site rebuilt in a SiteFlo design before deciding.

## Hosting, speed and security

SiteFlo sites are pre-built pages served from Cloudflare's global network, so there is no
WordPress to patch and nothing for attackers to log in to.

- **Fast everywhere**: pages and images served from data centres close to each visitor.
- **No plugins to update**: no database or admin login on the public site.
- **Security headers** on every page, and the staff form locked behind a one-time email code.
- **Each client separate**: its own code repository, storage and deploy key.
- **Every change reversible**: each edit is one recorded change that can be rolled back.
- **Analytics your way**: Cloudflare, Google Analytics, Plausible, Fathom, Matomo and others, or none.

## Coming next

These are planned, not built. Don't promise them to customers as available. Details: `docs/ROADMAP.md`.

| Idea | What it would do |
| --- | --- |
| Preview before approving | A link to the changed page on the approval card |
| Section changes | Hide, show or reorder sections on designed pages from Slack |
| Documents | Post a PDF (menu, newsletter, annual report) and have it linked on the site |
| Key facts | Hours, holiday hours, phone and address kept in one place |
| More photo work | Add or remove photos inside page text, and galleries |
| Microsoft Teams | The same bot for clients who use Teams |
| Google Analytics in Slack | Visitor numbers from GA4 |
| Uptime monitoring | Alerts when a site, form or bot stops working |
| Headless WordPress | Keep WordPress for editing large sites, with SiteFlo serving the public site |
| More templates | Designs for nonprofits, hospitality, professional services and arts groups |
