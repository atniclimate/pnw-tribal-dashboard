// @ts-check
/**
 * APG disclosure (button plus region): aria-expanded on the button, aria-controls naming the region, and
 * the region's hidden attribute toggled. Long alert text is collapsed this way (blueprint 9.6). The button
 * keeps its place in the tab order and focus never moves on toggle. DOM module. Owner: lane L1.
 */

let counter = 0;

/**
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} region
 * @returns {() => void} teardown that removes the listener and leaves the region expanded
 */
export function initDisclosure(button, region) {
  if (!region.id) { counter += 1; region.id = `disclosure-${counter}`; }
  button.type = 'button';
  button.classList.add('disclosure__button');
  region.classList.add('disclosure__region');
  button.setAttribute('aria-controls', region.id);
  // Collapsed unless the markup says aria-expanded="true".
  set(button.getAttribute('aria-expanded') === 'true');

  /** @param {boolean} open */
  function set(open) {
    button.setAttribute('aria-expanded', String(open));
    region.hidden = !open;
  }
  const onClick = () => set(button.getAttribute('aria-expanded') !== 'true');
  button.addEventListener('click', onClick);
  return () => {
    button.removeEventListener('click', onClick);
    set(true);
  };
}
