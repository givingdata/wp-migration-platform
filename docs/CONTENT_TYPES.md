# Content types

The kinds of entry staff can add through the form: by default **News**, **Event** and
**Announcement**. Each client's list is `contentTypes` in `config/design-specs.json`; the staff
form, the Worker, the Edit module and the site all read it (through `lib/content-types.js`), so
adding, renaming or hiding a type is a settings change. Push it and both the Worker and the site
redeploy.

| Type (key) | Shows as | Stored in | Page | Notes |
|---|---|---|---|---|
| `post` | News | `posts` | `/news/` | Same key as WordPress posts, so migrated posts are News |
| `event` | Event | `events` | `/events/` | Upcoming and past, split on the end date (or date) |
| `announcement` | Announcement | `announcements` | `/announcements/` | Short notice; shows in a banner at the top of the homepage from **Show from** until **Show until** (no end date: until deleted) |

Dates are checked when the site is built. `rebuild.yml` rebuilds every day at 06:00 UTC, so
announcements appear and expire, and events move to "past", without anyone committing.

## Settings for a type

```json
"announcement": {
  "label": "Announcement",              // shown in the form and on the site
  "collection": "announcements",        // key in content.json
  "layout": "article",                  // article | event | exhibition
  "listing": { "path": "announcements", "title": "Announcements", "intro": "…",
               "upcoming": false },     // true: split into current/upcoming and past
  "homepage": false,                    // true: a row of cards on the default homepage
  "banner": true,                       // true: current entries show in the homepage banner
  "dateLabel": "Show from",
  "fieldLabels": { "endDate": "Show until", "linkUrl": "Link for “Learn more”" },
  "prompt": "Announcements are short notices…",   // extra instruction for Claude's tidy-up
  "aspectRatio": "16:9", "minWidth": 300, "maxWidth": 1200, "crop": "center",
  "fields": ["title", "description", "date", "endDate", "linkUrl", "image"]
}
```

Fields the form knows: `title`, `description`, `date` (always), `endDate`, `time`, `location`,
`author`, `linkUrl` (a "Learn more" button, used exactly as typed) and `image`.

## Adding, hiding and opting in

- **Hide a type:** remove it from `contentTypes`. Entries already on the site stay where they
  are; staff just can't add new ones.
- **New type** (e.g. job postings): add an entry with a new key; `label`, `collection`,
  `layout`, `listing` and `fields` are enough. Its page is `/<listing.path>/`.
- **Exhibitions (arts clients):** opt in with

  ```json
  "exhibition": { "label": "Exhibition", "homepage": true,
                  "fields": ["title", "description", "date", "endDate", "location", "image"] }
  ```

  The rest (1.5:1 images, `/exhibitions/`, the exhibition layout, "Now showing" on the default
  homepage) comes from the built-in defaults in `lib/content-types.js`.

Existing links never change: a type's entries keep their bare `/<slug>/` paths (prefixed with the
type only when two entries share a slug), whatever the type is called.
