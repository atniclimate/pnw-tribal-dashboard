// @ts-check
/** Publish official resource links while editorial Safety guidance awaits its named reviewer. */

/**
 * Keep the reviewed page unchanged. For a draft, retain topic anchors, official source links,
 * alert highlights, and verified contact hooks, but do not publish unapproved advice.
 * @param {string} html
 * @returns {string}
 */
export function publishSafety(html) {
  if (!html.includes('data-review-status="draft"')) return html;
  let topics = 0;
  const result = html.replace(/(<section\b[^>]*class="safety-section"[^>]*>)([\s\S]*?)<\/section>/g, (_match, opening, content) => {
    const heading = content.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/)?.[0];
    const sources = content.match(/<p class="caption">[\s\S]*?<\/p>/)?.[0];
    if (!heading || !sources) throw new Error('Draft Safety topic is missing its heading or official sources');
    topics++;
    const aliases = [...content.matchAll(/<span id="[a-z-]+"><\/span>/g)].map((m) => m[0]);
    const active = content.match(/<p\b[^>]*data-active-now[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';
    const call = content.match(/<p data-call>[\s\S]*?<\/p>/)?.[0] ?? '';
    return `${opening}\n      ${[heading, ...aliases, active, '<p>Official preparedness and response guidance is available from the sources below.</p>', call, sources].filter(Boolean).join('\n      ')}\n    </section>`;
  });
  if (topics !== 10) throw new Error(`Expected ten draft Safety topics, found ${topics}`);
  return result.replace(/<p\b[^>]*data-review-status="draft"[^>]*>[\s\S]*?<\/p>/,
    '<p class="callout callout--quiet" data-review-status="official-links"><strong>Official Safety Resources:</strong> Follow the linked agencies for preparedness and response guidance. Additional local guidance is awaiting a named reviewer\'s approval and is not published here. This page does not replace official warnings, evacuation orders, or 911.</p>');
}
