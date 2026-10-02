# Design handoff spec

For designers creating a custom look for a client site on this platform. Every client site runs on
the same code. A design becomes **settings** (colours, fonts, shapes, logo) in the client's
`config/theme.json`, not a separately built site. Designs that stay within this spec can be built
in an hour or two. Anything outside it is custom work, quoted separately (see
[What counts as custom](#what-counts-as-custom)).

## 1. Start from a preset

Pick the preset closest to the client and change only what's different. Anything you don't set
keeps the preset's value.

| Preset | Character |
|---|---|
| `classic` | Plum accent, serif headings, soft corners (the default) |
| `community` | Warm terracotta, rounded corners, friendly bold sans headings |
| `editorial` | Black and white, crimson accent, square corners, serif headings, narrow text column |
| `modern` | Indigo accent, heavy sans headings, off-white background |
| `minimal` | Greyscale, small corners |
| `bistro` | Restaurants and cafés: forest green and sage, large serif headings, square corners (adds its own styling beyond the tokens) |

To see one: set `"preset"` in `config/theme.json`, run `npm run dev`, and open http://localhost:3000.

## 2. Design tokens

These names are the contract. Use them **exactly** as written for your Figma variables, so the
file maps straight onto the site. The build rejects names it doesn't know.

### Colours (Figma collection `color`, modes `light` and `dark`)

| Token | Used for |
|---|---|
| `bg` | Page background |
| `surface` | Header, cards, dropdown menus |
| `surface-2` | Tags, subtle fills |
| `text` | Body text, headings, card titles |
| `muted` | Dates, captions, secondary text, footer |
| `border` | Header/footer rules, card outlines, table lines |
| `accent` | Links, eyebrow labels, hovered card titles, blockquote rule |
| `accent-hover` | Links on hover |
| `heading` | Headings (can differ from `text`) |
| `band-bg` | Background of contrasting bands: the banded header, dark section strips (`tone: band`), the rich footer |
| `band-text` | Text on a band |
| `band-muted` | Secondary text on a band |
| `band-accent` | Links and highlights on a band |
| `focus` | Keyboard focus outline (must stand out against `bg` and `surface`) |
| `overlay` | Optional. Shade over photos with text on them (homepage hero, quote). Defaults to the band colour; set a neutral dark (e.g. `#111111`) to keep photos' own colours |

Supply both modes. If the client doesn't want dark mode, say so and we set `"darkMode": false`.

### Type and shape (Figma collection `theme`)

| Token | Used for | Example |
|---|---|---|
| `font-body` | Body text, navigation | `"Inter", system-ui, sans-serif` |
| `font-heading` | Headings, site name | `"Fraunces", Georgia, serif` |
| `heading-weight` | Weight of headings and site name | `600` |
| `text-size` | Base body text size | `1.0625rem` (17px) |
| `radius` | Corners on cards, images, menus | `10px`, `0px` for square |
| `wrap` | Maximum page width | `72rem` (1152px) |
| `narrow` | Maximum width of article text | `44rem` (704px) |
| `button-radius` | Corners on buttons | `999px` (pill), `0px` for square |

Heading sizes are fixed (h1 is 2–3rem, scaling with screen width; h2 is 1.5–1.9rem; h3 is
1.25rem). Spacing is not a token yet. A preset can change heading sizes and other styling in its
own CSS file (`site/src/styles/presets/<preset>.css`, as `bistro` does); only sites using that
preset load it.

### Fonts

- Use **Google Fonts** or another open-licence font (SIL OFL). List each family with the
  weights used, such as `Inter:wght@400;500;700`.
- Commercial fonts need a web licence covering the client's domain, bought by or billed to the
  client. Flag this before designing with one.
- Always give a fallback (`serif` or `sans-serif`) at the end of the stack.

### Logo

SVG preferred (a PNG at least 2× display size also works). Say what height it should display at in the
header (default 40px), and whether the site name appears as text beside it. If the logo doesn't
work on a dark background, supply a dark-mode version (`logo.darkSrc`).

## 3. What to design

Show the tokens applied to the pages that exist today, at **1440px** (desktop) and **390px**
(phone):

- **Header**: logo/site name plus the main menu, including one dropdown (submenu) open
- **Homepage**: built from sections (see below), or the default intro and card grids (news, events)
- **Listing page**: a grid of cards
- **Entry pages**: a post and an event (image beside details on desktop); an exhibition only if the
  client has the optional exhibition type
- **A general page** with WordPress content: headings, lists, a quote, a table, an image with a
  caption and a photo gallery
- **Footer** and the **404** page. The footer ends with a small "Website by SiteFlo" line (linking to
  flomysite.com) in the footer's muted text colour: leave room for it. It's on for every site unless
  we've agreed with the client to remove it

Image shapes are set per content type in the client's `config/design-specs.json`. The defaults are
posts **16:9** and events **1:1** (exhibitions **3:2** when used). Design cards and entry images at
those ratios, or ask for a different ratio for this client before launch: staff-uploaded photos are
cropped to it automatically, and photos already uploaded keep the old shape.

Pages can also be built from **sections** (`sections.json`), in any order: `hero` (photo behind the
text, optionally with a slow-scrolling parallax photo, or beside it), `split` (text beside a photo), `cards`, `tiles` (photos with titles), `scenes`
(full-width photo panels with a text card over each, photos scrolling slowly behind), `features`
(icons), `stats`, `quote`, `stories`, `text`, `posts` (latest news or events), `menu` (a price list)
and `cta`. Each section can use the page background, an alternate fill or the band colours. Section
photos have their own shapes (hero 4:5 beside the text, split 5:4, tiles 5:7); a preset can change
them. Show which sections each designed page uses, in order.

## 4. Accessibility (required)

- Text contrast **4.5:1** or better, in both modes: `text`, `muted` and `accent` on `bg` and
  `surface`, and `text` on `surface-2`. The build warns when a pair falls short, and we fix
  those before launch.
- Visible keyboard focus (the `focus` colour), and links distinguishable from body text by more
  than colour. Underlines stay on in body text.
- No text baked into images.

## 5. Deliverables

- [ ] A Figma link (view access is enough), **or** exports: variables as JSON (any export plugin)
      and PNG frames of the pages above
- [ ] The token values: the table in section 2, filled in for light and dark
- [ ] Font families and weights, with licence confirmation for any non-Google font
- [ ] Logo files (SVG) and display height
- [ ] Notes on anything that can't be expressed with tokens (see below)

## What counts as custom

Included: anything expressible with the tokens, preset, fonts and logo above.

Custom (quoted separately; built as extra components in the client's own repo):

- New section types beyond the list in section 3 (choosing and ordering the existing ones is included)
- A different header or navigation pattern (centred logo, mega-menu, sticky or transparent header)
- New components: donation meters, sliders or carousels, maps, embedded forms
- Per-page layouts, animation, or background images and textures
- Spacing or heading-size changes

## How it gets built

The tokens go into the client's `config/theme.json`. For example:

```json
{
  "preset": "community",
  "colors": { "accent": "#1d6b5f", "accent-hover": "#14504a" },
  "darkColors": { "accent": "#7fd1c2", "accent-hover": "#a8e3d8" },
  "darkMode": true,
  "tokens": { "font-heading": "\"Fraunces\", Georgia, serif", "radius": "6px" },
  "googleFonts": ["Fraunces:wght@600;700"],
  "logo": { "src": "/logo.svg", "height": 44, "showName": false }
}
```

The logo goes in `site/public/`, or on the client's media domain as a full URL. Pushing the
change rebuilds and deploys the site. To review it before it goes live, run `npm run dev`, or
deploy a preview: `npm run build && npx wrangler pages deploy site/dist --project-name <project>
--branch design-review` (it gets its own `design-review.<project>.pages.dev` URL).
