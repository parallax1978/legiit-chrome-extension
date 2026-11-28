/**
 * The thin summary strip above Google results.
 *
 * It is additive (inserted above the results, nothing is hidden, moved or
 * restyled), collapsible, and lives in a closed shadow root so neither the
 * page's styles nor its scripts can reach into it. All text is set with
 * textContent; no page-derived HTML is ever injected.
 */
import { PRODUCT_NAME } from '@/config/constants';
import type { ClickPotential } from '@/features/click-potential/metrics';
import { CROWDING_LABELS, CROWDING_MEANING, crowdingOf, howFarDown } from '@/features/overview/words';
import { formatInt } from '@/lib/text';

export interface StripCallbacks {
  onOpenPanel: () => void;
  onToggle: (collapsed: boolean) => void;
  onSave: () => void;
}

export const STRIP_ATTRIBUTE = 'data-legiit-lens-strip';

const CSS_TEXT = `
:host { all: initial; display: flow-root; }
.wrap { container-type: inline-size; padding: 0 16px 10px 0; }
.bar { box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: 100%; padding: 4px 6px 4px 10px;
  border: 1px solid #c7d2fe; border-radius: 14px; background: #f5f7ff; color: #1e2a55;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: nowrap; }
.brand { font-weight: 700; letter-spacing: .01em; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #2563eb; margin-right: 6px; }
.chip { padding: 1px 8px; border-radius: 999px; background: #fff; border: 1px solid #dbe2ff; }
.chip b { font-weight: 700; }
.chip.grade-A, .chip.grade-B { border-color: #86efac; background: #f0fdf4; }
.chip.grade-C { border-color: #fde68a; background: #fffbeb; }
.chip.grade-D, .chip.grade-F { border-color: #fca5a5; background: #fef2f2; }
.chip.mine { border-color: #93c5fd; background: #eff6ff; }
.note { color: #5b6690; }
button { all: unset; box-sizing: border-box; cursor: pointer; padding: 2px 10px; border-radius: 999px; font: inherit; font-weight: 600; }
button.primary { background: #2563eb; color: #fff; }
button.ghost { color: #1e2a55; border: 1px solid #c7d2fe; background: #fff; }
button:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
button[disabled] { opacity: .6; cursor: default; }
/* On a narrow page the user's own place stays; where the results start is what gives way. */
@container (max-width: 620px) { .chip.first { display: none; } }
@media (prefers-color-scheme: dark) {
  .bar { background: #1b2238; border-color: #3b4a7a; color: #e5e9ff; }
  .chip { background: #232c48; border-color: #3b4a7a; }
  .chip.grade-A, .chip.grade-B { background: #12301f; border-color: #2f6f47; }
  .chip.grade-C { background: #33290f; border-color: #7a6220; }
  .chip.grade-D, .chip.grade-F { background: #3a1717; border-color: #8a3a3a; }
  .chip.mine { background: #16294a; border-color: #3b68b0; }
  .note { color: #a9b3d6; }
  button.ghost { color: #e5e9ff; background: #232c48; border-color: #3b4a7a; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Strip {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private collapsed: boolean;
  private model: ClickPotential | null = null;
  private saved = false;
  private showSave = true;
  /** True when the user tracks a site of their own: the strip then says so when it has no result here. */
  private hasMine = false;

  /**
   * @param anchor  The strip is inserted immediately before this element.
   * @param alignTo The strip's left edge lines up with this element (the results column).
   */
  constructor(
    anchor: Element,
    private readonly alignTo: Element | null,
    collapsed: boolean,
    private readonly callbacks: StripCallbacks,
  ) {
    this.collapsed = collapsed;
    this.host = document.createElement('div');
    this.host.setAttribute(STRIP_ATTRIBUTE, '');
    // A flow-root with no margin of its own: its height (inner spacing included) is exactly how far it pushes the results down.
    this.host.style.cssText = 'display:flow-root;margin:0;padding:0;border:0;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      this.root.adoptedStyleSheets = [sheet];
    } catch {
      this.root.appendChild(el('style', undefined, CSS_TEXT));
    }
    anchor.parentNode?.insertBefore(this.host, anchor);
    this.render();
    this.align();
  }

  /** Lines the strip up with the left edge of the results column. */
  align(): void {
    if (!this.alignTo || !this.host.isConnected) return;
    const offset = Math.max(0, Math.round(this.alignTo.getBoundingClientRect().left - this.host.getBoundingClientRect().left));
    this.host.style.paddingLeft = `${offset}px`;
  }

  /** Vertical space the strip takes above the results, in CSS pixels. */
  get height(): number {
    return this.host.isConnected ? this.host.getBoundingClientRect().height : 0;
  }

  isAttached(): boolean {
    return this.host.isConnected;
  }

  update(model: ClickPotential, options: { saved: boolean; showSave: boolean; hasMine?: boolean }): void {
    this.hasMine = options.hasMine === true;
    this.model = model;
    this.saved = options.saved;
    this.showSave = options.showSave;
    this.render();
  }

  markSaved(): void {
    this.saved = true;
    this.render();
  }

  remove(): void {
    this.host.remove();
  }

  private render(): void {
    const style = this.root.querySelector('style');
    const wrap = el('div', 'wrap');
    const bar = el('div', 'bar');
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', `${PRODUCT_NAME} summary`);
    wrap.appendChild(bar);

    const brand = el('span', 'brand');
    brand.append(el('span', 'dot'), PRODUCT_NAME);
    bar.appendChild(brand);

    const toggle = el('button', 'ghost', this.collapsed ? 'Show' : 'Hide');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!this.collapsed));
    toggle.title = this.collapsed ? `Show the ${PRODUCT_NAME} summary` : 'Collapse this strip';
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.callbacks.onToggle(this.collapsed);
      this.render();
    });

    if (!this.collapsed) {
      const cp = this.model;
      if (!cp || !cp.measured) {
        bar.appendChild(el('span', 'note', 'Measuring this results page…'));
      } else {
        const chip = (label: string, value: string, extra = '', title = ''): HTMLElement => {
          const node = el('span', `chip ${extra}`.trim());
          node.append(`${label} `, el('b', undefined, value));
          if (title) node.title = title;
          return node;
        };
        // Plain words: where the user is, where the results start, and how crowded the page is.
        const mine = cp.tracked.filter((t) => t.owner === 'mine').sort((a, b) => (a.position ?? 999) - (b.position ?? 999))[0];
        if (mine) {
          const where = howFarDown(mine.top, cp.viewport.height);
          bar.appendChild(chip('You', `#${mine.position}${where ? ` · ${where}` : ''}`, 'mine', `${mine.name}: result #${mine.position} on this page`));
        } else if (this.hasMine) {
          bar.appendChild(chip('You', 'not on this page', 'mine', 'None of your sites has a result on this page'));
        }
        bar.appendChild(
          cp.firstOrganicTop === null
            ? chip('First result', 'none found', 'first')
            : chip('First result', howFarDown(cp.firstOrganicTop, cp.viewport.height), 'first', `The first regular result starts ${formatInt(cp.firstOrganicTop)} px from the top of the page`),
        );
        const crowding = crowdingOf(cp.grade.letter);
        bar.appendChild(
          chip('This search:', CROWDING_LABELS[crowding].toLowerCase(), `grade-${cp.grade.letter}`, `${CROWDING_MEANING[crowding]} Room for regular results: ${cp.grade.score} out of 100 (an estimate). Open the panel to see what that means for you.`),
        );
      }

      if (this.showSave) {
        const save = el('button', 'ghost', this.saved ? 'Saved' : 'Save');
        save.type = 'button';
        save.title = 'Save a snapshot of this measurement on this device';
        save.setAttribute('aria-label', this.saved ? 'Snapshot saved' : 'Save snapshot');
        save.disabled = this.saved || !this.model?.measured;
        save.addEventListener('click', () => this.callbacks.onSave());
        bar.appendChild(save);
      }
      const open = el('button', 'primary', 'Open panel');
      open.type = 'button';
      open.addEventListener('click', () => this.callbacks.onOpenPanel());
      bar.appendChild(open);
    }
    bar.appendChild(toggle);

    this.root.replaceChildren(...(style ? [style] : []), wrap);
  }
}
