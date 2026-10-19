// Reused from LuckyMonkyBaby/decks-monorepo 177a52bf; see docs/provenance.md.
/**
 * Pagination plugin for TipTap / ProseMirror.
 *
 * Two layers, kept independent:
 *
 *   1. STRUCTURE — this file. A ProseMirror plugin that walks the document
 *      block-by-block, asks the measurer for each block's rendered height at
 *      the page's content width, and inserts widget decoration spacers wherever
 *      a block would otherwise cross a page boundary. The spacers push the
 *      block down to the top of the next page's usable area, producing visible
 *      Word-style page breaks WITHOUT mutating the document JSON.
 *
 *   2. MEASUREMENT — direct DOM. Each block's height is read straight from
 *      `getBoundingClientRect()` on the rendered element. The browser has
 *      already laid out the content using the correct font, kerning, and
 *      line-wrapping rules, so its measurement is exact by construction.
 *      No font-shorthand parsing, no Canvas font cache races, no drift
 *      between measurement and rendering. CSS is the single source of truth
 *      because the only thing the plugin reads is what the browser produced.
 *
 *      Pretext (Canvas-based shaping) was the original plan but it's the
 *      wrong tool here: it's designed for measuring text BEFORE it's rendered
 *      (e.g. flowing text around moving obstacles), and we already have the
 *      rendered DOM in front of us. Pretext earns its keep at iteration 2
 *      when we want to break MID-paragraph and need line-level positions
 *      that the DOM can't expose without instrumenting every line.
 *
 * Day 1 scope: BLOCK-LEVEL breaks only. A whole paragraph either fits on the
 * current page or jumps to the next one. Mid-paragraph breaks (Word-style line-
 * level pagination, where one paragraph straddles two pages) are an iteration
 * 2 concern — they require mapping pretext's `LayoutCursor` back to ProseMirror
 * positions, which is doable but adds complexity we don't need to ship the
 * first working version.
 *
 * The decoration set is recomputed on every doc-changing transaction. Document
 * tree is never mutated, so undo, selection, collaborative cursors, and
 * paste/cut all keep working without any pagination-specific glue.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';

// ──────────────────── types ───────────────────────────────────────────────────

export interface PaginationOptions {
  /** Total page height in px (e.g. 1123 for A4 at 96dpi). */
  pageHeight: number;
  /** Top margin inside each page (content area starts here). */
  pageMarginTop: number;
  /** Bottom margin inside each page (content area ends here). */
  pageMarginBottom: number;
  /** Visual gap between stacked pages in px. */
  pageGap: number;
  /** Width of the content column in px (page width minus left/right margins). */
  contentWidth: number;
  /** Optional: notified when the page count changes so the host can grow the canvas. */
  onPageCountChange?: (pageCount: number) => void;
}

export interface BlockMeasurement {
  /** Rendered height of the block's text content (no margins). */
  height: number;
  /** Margin space before the block. */
  marginTop: number;
  /** Margin space after the block. */
  marginBottom: number;
  /**
   * If true, this block must stay glued to the block immediately following
   * it. Used for headings: a heading should never be the last thing on a
   * page with its body content on the next page (orphan heading). When the
   * boundary algorithm encounters a `keepWithNext` block, it treats it as
   * atomic with the next block — if the combined footprint doesn't fit, it
   * breaks BEFORE the keepWithNext block, not after.
   */
  keepWithNext?: boolean;
}

export interface PageBoundary {
  /** ProseMirror position immediately before the block that should start a new page. */
  pos: number;
  /** Pixel height of the spacer widget that pushes the block to the next page. */
  spacerHeight: number;
}

/**
 * Per-block layout entry. Pretext-style: stored as a parallel array indexed
 * in document order, so binary search by `pos` is O(log N) for any
 * "what page is this position on" query.
 *
 * Used by `getPageOfPos()` and consumed externally by AI tools, comment
 * markers, citation widgets, and per-page slide layer anchoring (Phase 2d).
 */
export interface BlockLayoutEntry {
  /** ProseMirror position before the block. */
  pos: number;
  /** 0-indexed page this block lives on after pagination. */
  page: number;
  /** Y-offset within the block's page (px from page content-area top). */
  yInPage: number;
  /** Block's measured footprint (marginTop + height + marginBottom). */
  footprint: number;
}

/**
 * Full layout state produced by one boundary computation pass. The plugin
 * stores this in its state so consumers can do O(log N) lookups without
 * walking the boundary list.
 */
export interface LayoutModel {
  boundaries: PageBoundary[];
  pageCount: number;
  /** Per-block index in document order. Sorted by `pos` ascending. */
  blocks: BlockLayoutEntry[];
}

/** Geometry inputs to the boundary algorithm — extracted so the pure helper
 *  doesn't need the full PaginationOptions. */
export interface PageGeometry {
  pageHeight: number;
  pageMarginTop: number;
  pageMarginBottom: number;
  pageGap: number;
}

/**
 * Pure boundary computation. Given an ordered list of `(measurement, position)`
 * tuples — one per top-level block — return the page-break positions and the
 * total page count needed.
 *
 * Algorithm uses ABSOLUTE EDITOR COORDINATES (not page-relative cursorY).
 * This is the right model because:
 *
 *   - Each page's content area is at a known absolute y in editor space:
 *     `pageIndex * (usableHeight + interPageGap)` where interPageGap =
 *     bottomMargin + pageGap + topMargin.
 *   - When inserting a break, the spacer height is simply
 *     `(nextPageContentTop - absoluteCursorY)` — always non-negative,
 *     always correctly accounting for blocks that overflow past the
 *     current page's content bottom.
 *   - When a single block is taller than `usableHeight` (e.g. a giant
 *     table or a long code block), the absolute cursor advances PAST the
 *     current page's bottom, possibly past the next page's bottom too.
 *     Subsequent blocks correctly skip to whichever page comes after the
 *     overflow, instead of computing a negative spacer.
 *
 * Page-relative tracking (the old approach) loses this information: when
 * cursorY > usableHeight, the page-relative model thinks the block ended
 * at cursorY but doesn't know which absolute page that maps to. The
 * spacer formula `(usableHeight - cursorY) + interPageGap` produces
 * negative values when cursorY > usableHeight, which the browser silently
 * treats as zero — making the page break invisible.
 *
 * Pure function. Unit-tested at __tests__/pagination-plugin.test.ts.
 */
export function computeBoundariesFromMeasurements(
  blocks: ReadonlyArray<{ measurement: BlockMeasurement; pos: number }>,
  geometry: PageGeometry,
): LayoutModel {
  const usableHeight = geometry.pageHeight - geometry.pageMarginTop - geometry.pageMarginBottom;
  // Inter-page advance in absolute editor space: the distance from the top
  // of one page's content area to the top of the next page's content area.
  // This is the "page stride" — usable + bottom margin + visual gap + top
  // margin = the full repeat unit of the page stack.
  const interPageGap = geometry.pageMarginBottom + geometry.pageGap + geometry.pageMarginTop;
  const pageStride = usableHeight + interPageGap;

  const boundaries: PageBoundary[] = [];
  const blockIndex: BlockLayoutEntry[] = [];

  let pageIndex = 0;
  // Absolute cursor y in editor coordinates. NEVER resets — it grows as
  // blocks and spacers are placed, then breaks just push the cursor
  // forward by spacerHeight to land on the next page's content top.
  let absoluteY = 0;
  // The previous block's marginBottom, pending application to the next
  // block's marginTop. CSS collapses adjacent vertical margins between
  // sibling block elements to max(a, b) — NOT a + b. If we add both
  // linearly the cursor overestimates the real DOM layout and every page
  // break accumulates drift, which ultimately lets body text bleed into
  // the next page's header chrome zone. Tracking the pending margin and
  // resolving it with max() against the next block's marginTop mirrors
  // what the browser actually does.
  let pendingMarginBottom = 0;

  /** y of the current page's content-area top in absolute editor coords. */
  const currentPageContentTop = () => pageIndex * pageStride;
  /** y of the current page's content-area bottom in absolute editor coords. */
  const currentPageContentBottom = () => currentPageContentTop() + usableHeight;

  for (let i = 0; i < blocks.length; i++) {
    const { measurement: m, pos } = blocks[i]!;
    // Effective top gap AFTER CSS margin-collapsing against the previous
    // block's bottom margin. The first block on a page has no previous
    // sibling (the spacer resets context), so pendingMarginBottom is
    // already 0 by virtue of having been consumed below.
    const effectiveMarginTop = Math.max(pendingMarginBottom, m.marginTop);
    const blockFootprint = effectiveMarginTop + m.height;

    // KEEP-WITH-NEXT: if this block is a heading (or otherwise marked
    // keepWithNext), peek at the next block and treat them as an atomic
    // group for the fit check. If the group doesn't fit on the current
    // page, break BEFORE the heading rather than between heading and body.
    // The group's internal gap between heading and body ALSO collapses.
    let fitFootprint = blockFootprint;
    if (m.keepWithNext && i + 1 < blocks.length) {
      const next = blocks[i + 1]!.measurement;
      const innerGap = Math.max(m.marginBottom, next.marginTop);
      fitFootprint += innerGap + next.height;
    }

    // Should we break before this block? Yes if:
    //   1. The block isn't the first one on its page (otherwise we'd loop
    //      on giant blocks that exceed usableHeight), AND
    //   2. The block (or keepWithNext group) would extend past the current
    //      page's content bottom in absolute coordinates.
    const isFirstOnPage = absoluteY === currentPageContentTop();
    const wouldOverflow = absoluteY + fitFootprint > currentPageContentBottom();

    if (!isFirstOnPage && wouldOverflow) {
      // Compute the next page's content top in absolute coordinates. If
      // the cursor has overflowed past the current page's bottom (because
      // the previous block was taller than usableHeight), advance pageIndex
      // by however many pages worth of overflow there were.
      let targetPageIndex = pageIndex + 1;
      while (targetPageIndex * pageStride < absoluteY) {
        targetPageIndex++;
      }
      const nextPageContentTop = targetPageIndex * pageStride;
      const spacerHeight = nextPageContentTop - absoluteY;

      // Defensive: spacerHeight should always be >= 0 by construction
      // (because we advanced targetPageIndex past the overflow), but cap
      // at zero just in case of float drift.
      boundaries.push({ pos, spacerHeight: Math.max(0, spacerHeight) });
      pageIndex = targetPageIndex;
      absoluteY = nextPageContentTop;
      // After a page break the new block is the FIRST on its page — its
      // top margin doesn't collapse against anything (there's no previous
      // sibling in flow; the spacer widget resets the margin context).
      pendingMarginBottom = 0;
    }

    // Record this block's layout BEFORE advancing the cursor. Use the
    // post-collapse blockFootprint so yInPage / footprint agree with
    // what the browser actually renders.
    blockIndex.push({
      pos,
      page: pageIndex,
      yInPage: absoluteY - currentPageContentTop(),
      footprint: blockFootprint + m.marginBottom,
    });

    absoluteY += blockFootprint;
    pendingMarginBottom = m.marginBottom;

    // If THIS block overflowed past the current page's content area
    // (giant table, long code block), advance pageIndex to wherever the
    // cursor lands. The next block's break check needs an accurate
    // pageIndex to know which page it's currently on.
    while (absoluteY >= (pageIndex + 1) * pageStride) {
      pageIndex++;
    }
  }

  return { boundaries, pageCount: pageIndex + 1, blocks: blockIndex };
}

// ──────────────────── DOM-driven measurement ─────────────────────────────────

/**
 * Measure one block by reading its actual rendered styles + raw text content
 * and re-shaping with pretext at the given content width. Returns the
 * pretext-computed text height (which matches what the browser will paint
 * because we're using the same font + line-height) plus the computed CSS
 * margins so the caller can advance the page cursor correctly.
 *
 * If the block has no DOM yet (rare — happens briefly between transaction
 * apply and view re-render), returns null and the caller should skip the
 * boundary computation for this transaction.
 */
/** Tag names whose blocks should never be separated from the block that
 *  follows them. Headings are the canonical case — a heading at the bottom
 *  of one page with its content on the next is a typography crime. */
const KEEP_WITH_NEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function measureBlockFromDom(blockEl: HTMLElement): BlockMeasurement {
  // The browser has already rendered this block. Trust its measurement —
  // `getBoundingClientRect().height` is the exact pixel height the user sees,
  // including correct font metrics, kerning, line wrapping, tables, charts,
  // images — anything the browser laid out, we read directly.
  //
  // This call is wrapped by `BlockMeasurementCache.getOrMeasure`, so it
  // only runs on cache miss. Async-rendering content (charts, images, etc.)
  // is handled by per-block ResizeObservers in the cache: when a block's
  // height changes, its cache entry is invalidated and re-measured on the
  // next recompute. Unchanged blocks are never re-measured.
  const cs = window.getComputedStyle(blockEl);
  const rect = blockEl.getBoundingClientRect();
  const marginTop = parseFloat(cs.marginTop) || 0;
  const marginBottom = parseFloat(cs.marginBottom) || 0;
  const keepWithNext = KEEP_WITH_NEXT_TAGS.has(blockEl.tagName);
  // Convert CSS zoom back to document coordinates so fit-to-window preserves pagination.
  const scale=blockEl.offsetWidth?rect.width/blockEl.offsetWidth:1;
  return { height: rect.height/(scale||1), marginTop, marginBottom, keepWithNext };
}

// ──────────────────── boundary computation ───────────────────────────────────

/**
 * Walk the doc and produce a list of page boundaries plus the total page count.
 *
 * Algorithm:
 *
 *   - Maintain `cursorY` = current y-position within the active page's usable
 *     area (0..usableHeight).
 *   - For each top-level block: read its computed style off the DOM, measure
 *     its text via pretext at content width. If `cursorY + marginTop + height`
 *     would exceed the page's usable height AND we're not already at the top
 *     of a page, this block needs to start a new page: push a boundary at the
 *     block's "before" position and reset `cursorY` to 0.
 *   - Otherwise advance `cursorY` by the block's full footprint.
 *
 * The first block on a page is always allowed to render even if it's taller
 * than the usable area (otherwise giant headings would loop forever).
 *
 * Returns null if any block's DOM isn't available yet (the caller should
 * keep the previous decoration set and re-run on the next transaction).
 */
/**
 * Measurement cache + per-block ResizeObserver. Inspired by pretext's
 * `segmentMetricCaches` (which never re-measures the same text+font twice):
 * we never re-measure the same DOM element until its `ResizeObserver` fires.
 *
 * Lifecycle:
 *   - On every boundary computation, walk the doc's top-level blocks
 *   - For each block, look up its rendered HTMLElement in the cache
 *     - HIT: use cached measurement, no DOM access
 *     - MISS: measure via getBoundingClientRect, store in cache, attach a
 *       ResizeObserver that will invalidate this entry on size change
 *   - After the walk, prune cache entries whose elements are no longer in
 *     the current doc (block deleted, replaced, or moved)
 *
 * Result: typing in paragraph 5 of a 100-page document triggers ONE
 * getBoundingClientRect (paragraph 5's RO fires, deletes its cache entry, the
 * next recompute re-measures only that block). All 99 other paragraphs are
 * served from cache. This is O(changed-blocks) per edit instead of O(blocks).
 */
class BlockMeasurementCache {
  private cache = new Map<HTMLElement, BlockMeasurement>();
  private observer: ResizeObserver | null = null;
  /** Set on each recompute pass to track which entries are still alive. */
  private aliveThisPass: WeakSet<HTMLElement> = new WeakSet();
  /** Called when ANY observed block resizes — host triggers a recompute. */
  private onInvalidate: () => void;

  constructor(onInvalidate: () => void) {
    this.onInvalidate = onInvalidate;
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        // Delete cache entries for resized blocks so the next recompute
        // re-measures them. Only those specific blocks get re-measured;
        // every other entry stays cached.
        for (const entry of entries) {
          this.cache.delete(entry.target as HTMLElement);
        }
        this.onInvalidate();
      });
    }
  }

  /** Begin a new recompute pass — reset the alive tracker. */
  beginPass(): void {
    this.aliveThisPass = new WeakSet();
  }

  /** Get a measurement, computing+caching+observing on cache miss. */
  getOrMeasure(blockEl: HTMLElement): BlockMeasurement {
    this.aliveThisPass.add(blockEl);
    const cached = this.cache.get(blockEl);
    if (cached) return cached;
    const measurement = measureBlockFromDom(blockEl);
    this.cache.set(blockEl, measurement);
    this.observer?.observe(blockEl);
    return measurement;
  }

  /** End a pass — disconnect observers for elements that didn't appear. */
  endPass(): void {
    // We can't iterate WeakSet directly, so walk the cache and prune entries
    // whose elements weren't touched this pass (block deleted/replaced).
    for (const el of Array.from(this.cache.keys())) {
      if (!this.aliveThisPass.has(el)) {
        this.cache.delete(el);
        this.observer?.unobserve(el);
      }
    }
  }

  destroy(): void {
    this.observer?.disconnect();
    this.cache.clear();
  }
}

function computePageBoundariesWithCache(
  view: EditorView,
  cache: BlockMeasurementCache,
  opts: PaginationOptions,
): LayoutModel | null {
  cache.beginPass();
  const blocks: Array<{ measurement: BlockMeasurement; pos: number }> = [];
  const doc = view.state.doc;
  let position = 0;

  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const dom = view.nodeDOM(position);
    if (!dom || !(dom instanceof HTMLElement)) {
      // DOM not ready yet — bail and let the next transaction retry.
      // Don't endPass here: the cache entries we touched stay alive for the
      // next attempt.
      return null;
    }
    const measurement = cache.getOrMeasure(dom);
    blocks.push({ measurement, pos: position });
    position += child.nodeSize;
  }

  cache.endPass();
  return computeBoundariesFromMeasurements(blocks, opts);
}

// ──────────────────── decoration construction ────────────────────────────────

function buildDecorations(doc: PMNode, boundaries: PageBoundary[]): DecorationSet {
  if (boundaries.length === 0) return DecorationSet.empty;

  // Filter out boundaries whose positions are no longer valid in the current
  // doc. This can happen when the doc was mutated between when we measured
  // (the previous microtask) and when we're building decorations (this
  // microtask). Positions outside [0, doc.content.size] would crash
  // `Decoration.widget` or the subsequent `DecorationSet.create`.
  const docSize = doc.content.size;
  const validBoundaries = boundaries.filter((b) => b.pos >= 0 && b.pos <= docSize);
  if (validBoundaries.length === 0) return DecorationSet.empty;

  const decos = validBoundaries.map((b) =>
    Decoration.widget(
      b.pos,
      () => {
        const spacer = document.createElement('div');
        spacer.className = 'pagination-page-break';
        spacer.setAttribute('contenteditable', 'false');
        spacer.style.height = `${b.spacerHeight}px`;
        spacer.style.width = '100%';
        spacer.style.pointerEvents = 'none';
        spacer.style.userSelect = 'none';
        return spacer;
      },
      // side: -1 means "this widget conceptually belongs to the position
      // BEFORE the block at `pos`" — important so the cursor lands inside the
      // block, not inside the spacer.
      { side: -1, key: `page-break-${b.pos}-${b.spacerHeight}` },
    ),
  );

  try {
    return DecorationSet.create(doc, decos);
  } catch {
    // Last-resort safety net: if create still throws (positions race), fall
    // back to empty. The next measurement pass will produce correct
    // decorations against the new doc.
    return DecorationSet.empty;
  }
}

// ──────────────────── plugin ──────────────────────────────────────────────────

/**
 * Plugin state shape. The decoration set is what ProseMirror's `props.decorations`
 * needs to render page-break spacers; the layout model is what external
 * consumers (AI tools, comment markers, layer anchoring) read for O(log N)
 * position-to-page lookups via `getPageOfPos()`.
 *
 * Both are produced by the same measurement pass — keeping them together in
 * one plugin state slot avoids dual sources of truth.
 */
export interface PaginationPluginState {
  decorations: DecorationSet;
  layout: LayoutModel | null;
}

const EMPTY_PLUGIN_STATE: PaginationPluginState = {
  decorations: DecorationSet.empty,
  layout: null,
};

export const paginationPluginKey = new PluginKey<PaginationPluginState>('pagination');

/**
 * O(log N) lookup: given a ProseMirror position, return the 0-indexed page
 * the block at that position lives on. Returns 0 if the plugin hasn't run a
 * measurement pass yet (no layout model).
 *
 * Use this from AI tools, comment markers, citation widgets, or anywhere
 * else that needs to answer "what page is content X on" without walking the
 * decoration list. Pretext-equivalent of binary-searching the per-segment
 * prefix-width arrays.
 */
export function getPageOfPos(
  state: { tr?: unknown },
  pos: number,
): number {
  // The state arg is typed loosely to avoid importing EditorState here just
  // for the type. Callers pass `editor.state` or `view.state`.
  const pluginState = paginationPluginKey.getState(state as never) as
    | PaginationPluginState
    | undefined;
  if (!pluginState?.layout || pluginState.layout.blocks.length === 0) return 0;

  const blocks = pluginState.layout.blocks;
  // Binary search for the largest block.pos <= input pos. That block contains
  // the requested position (or precedes it if the position is between blocks,
  // in which case we still want the preceding block's page).
  let lo = 0;
  let hi = blocks.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid]!.pos <= pos) {
      result = blocks[mid]!.page;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function createPaginationPlugin(opts: PaginationOptions): Plugin<PaginationPluginState> {
  let lastPageCount = -1;
  let viewRef: EditorView | null = null;
  let cache: BlockMeasurementCache | null = null;
  let scheduled = false;

  // Schedule a measurement pass on the next microtask. Coalesces multiple
  // invalidations (e.g. several blocks resizing at once) into one pass.
  // Wrapped in try/catch end-to-end: any error inside the measurement or
  // dispatch path is logged and swallowed so it can't take down the editor.
  // The next invalidation will retry against fresh doc state.
  const scheduleMeasure = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      try {
        if (!viewRef || !cache) return;
        const layout = computePageBoundariesWithCache(viewRef, cache, opts);
        if (!layout) return;
        if (opts.onPageCountChange && layout.pageCount !== lastPageCount) {
          lastPageCount = layout.pageCount;
          // Defer the React setState to the next microtask after this one,
          // so it doesn't run inside a ProseMirror dispatch.
          queueMicrotask(() => opts.onPageCountChange?.(layout.pageCount));
        }
        const decorations = buildDecorations(viewRef.state.doc, layout.boundaries);
        const newState: PaginationPluginState = { decorations, layout };
        const tr = viewRef.state.tr.setMeta(paginationPluginKey, newState);
        viewRef.dispatch(tr);
      } catch (err) {
        // Pagination is a non-critical layer — if it crashes, the editor
        // should keep working without page breaks until the next clean
        // recompute. Log so we can find the root cause but don't propagate.
        // eslint-disable-next-line no-console
        console.error('[pagination] recompute failed', err);
      }
    });
  };

  return new Plugin<PaginationPluginState>({
    key: paginationPluginKey,
    state: {
      // Initial state is empty — the real measurement pass runs in `view()`
      // below, after the DOM exists.
      init() {
        return EMPTY_PLUGIN_STATE;
      },
      apply(tr, old) {
        // We never compute decorations here because measurement requires the
        // view's nodeDOM, which isn't available in the apply step. Instead
        // the view callback below dispatches a meta transaction once it has
        // measured against the freshly-rendered DOM.
        const meta = tr.getMeta(paginationPluginKey) as PaginationPluginState | undefined;
        if (meta) return meta;

        // No-op transactions: just keep the old state.
        if (!tr.docChanged) return old;

        // Doc changed: try to map the existing decoration set forward through
        // the transaction so positions stay valid until the next measurement
        // pass arrives. This is a best-effort optimization to avoid one frame
        // of "no page breaks" between commit and re-measure.
        //
        // BUT: large transactions (AI streaming a `replaceWith` of a whole
        // block, table, or section) can produce mappings where decoration
        // positions resolve to invalid offsets in the new doc. ProseMirror
        // throws `RangeError: Position -1 out of range` in those cases, which
        // bubbles up and aborts the entire transaction processing pipeline —
        // breaking AI streaming, save mutations, and selection.
        //
        // Defensive strategy: try the mapping, catch any error, fall back to
        // an empty decoration set. The empty state is invisible because the
        // view callback's `update()` hook below immediately schedules a fresh
        // measurement pass on the next microtask, which repopulates correct
        // decorations against the new doc.
        try {
          return {
            decorations: old.decorations.map(tr.mapping, tr.doc),
            // Layout model positions also become stale on doc changes; null
            // it out so consumers don't binary-search against wrong positions.
            // The next measurement pass will rebuild it.
            layout: null,
          };
        } catch {
          return {
            decorations: DecorationSet.empty,
            layout: null,
          };
        }
      },
    },
    props: {
      decorations(state) {
        return paginationPluginKey.getState(state)?.decorations;
      },
    },
    view(view) {
      viewRef = view;
      // The cache OWNS the per-block ResizeObserver. When ANY observed block
      // changes size (chart settling, image loading, content edited, etc.),
      // the cache invalidates that one entry and asks us to recompute. The
      // recompute walks the doc, hits the cache for unchanged blocks, and
      // only re-measures the invalidated ones.
      cache = new BlockMeasurementCache(scheduleMeasure);

      // Initial pass + re-measure when fonts finish loading (otherwise the
      // first measurement uses fallback metrics for any text that depends
      // on a still-loading font).
      scheduleMeasure();
      if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
        void document.fonts.ready.then(() => {
          // Font load can change every block's height — clear the cache so
          // every block gets re-measured against the loaded fonts.
          cache?.destroy();
          cache = new BlockMeasurementCache(scheduleMeasure);
          scheduleMeasure();
        });
      }

      return {
        update(view, prevState) {
          if (view.state.doc === prevState.doc) return;
          // Doc changed — re-measure on the next microtask so ProseMirror
          // has had a chance to render the new DOM. The cache will hit on
          // unchanged blocks, miss on the new/edited ones, and the per-block
          // observers will be (re)attached during the pass.
          scheduleMeasure();
        },
        destroy() {
          cache?.destroy();
          cache = null;
          viewRef = null;
        },
      };
    },
  });
}

// ──────────────────── TipTap extension wrapper ───────────────────────────────

/**
 * TipTap extension wrapping `createPaginationPlugin`. Use via:
 *
 *   const editor = useEditor({
 *     extensions: [
 *       StarterKit,
 *       Pagination.configure({
 *         pageHeight: 1123,
 *         pageMarginTop: 96,
 *         pageMarginBottom: 96,
 *         pageGap: 32,
 *         contentWidth: 794 - 192,
 *       }),
 *     ],
 *   });
 *
 * No font configuration — the plugin reads computed styles from the rendered
 * editor DOM at measurement time.
 */
export const Pagination = Extension.create<PaginationOptions>({
  name: 'pagination',

  addOptions(): PaginationOptions {
    return {
      pageHeight: 1123,
      pageMarginTop: 96,
      pageMarginBottom: 96,
      pageGap: 32,
      contentWidth: 794 - 96 * 2,
    };
  },

  addProseMirrorPlugins() {
    return [createPaginationPlugin(this.options)];
  },
});
