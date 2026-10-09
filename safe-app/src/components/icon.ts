/**
 * Phosphor icon foundation.
 * Single icon set (@phosphor-icons/webcomponents), single consistent scale.
 * Importing this module once (from main.ts) registers every <ph-*> custom
 * element used across the app. Components reference the ph-* elements directly:
 *   <ph-copy size="${ICON_SIZE}" weight="${ICON_WEIGHT}"></ph-copy>
 */
import '@phosphor-icons/webcomponents/PhCopy';
import '@phosphor-icons/webcomponents/PhCheck';
import '@phosphor-icons/webcomponents/PhPlus';
import '@phosphor-icons/webcomponents/PhArrowSquareOut';
import '@phosphor-icons/webcomponents/PhArrowClockwise';
import '@phosphor-icons/webcomponents/PhTrash';
import '@phosphor-icons/webcomponents/PhX';
import '@phosphor-icons/webcomponents/PhPencilSimple';
import '@phosphor-icons/webcomponents/PhFileText';
import '@phosphor-icons/webcomponents/PhFolder';
import '@phosphor-icons/webcomponents/PhWarning';
import '@phosphor-icons/webcomponents/PhCaretUp';
import '@phosphor-icons/webcomponents/PhCaretDown';

/** Standard icon size (px) for every inline/action/button icon. */
export const ICON_SIZE = 16;
/** Hero size (px) for empty-state / standalone tree icons. */
export const ICON_SIZE_LARGE = 48;
/** Single phosphor weight used app-wide. */
export const ICON_WEIGHT = 'regular' as const;
