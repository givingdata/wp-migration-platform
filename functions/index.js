// Cloudflare Pages Function for the homepage only: old WordPress links such as
// /?p=123 or /?page_id=45 (which _redirects can't match) get a 301 to the page's new
// address, using wp-ids.json from the build. Every other request goes straight through.
export async function onRequestGet({ request, next, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("p") || url.searchParams.get("page_id");
  if (id && /^\d{1,10}$/.test(id)) {
    const res = await env.ASSETS.fetch(new URL("/wp-ids.json", url));
    if (res.ok) {
      const target = (await res.json())[id];
      if (target) return Response.redirect(new URL(target, url).href, 301);
    }
  }
  return next();
}
