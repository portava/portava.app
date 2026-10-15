/**
 * Remember together — /memory/together (census-highlights-memories H53, §5;
 * B58 cluster MEM-ANCHOR-2).
 *
 * This is the MOUNT. Every invitation to "Remember this together" and every
 * anchor the viewer accepted, with Accept / Decline / Leave, lives in
 * `src/features/memories/shared/SharedAnchorsScreen.tsx`. The in-app invitation
 * notice links here (a constant path: it names no Memory and no anchor), and the
 * Memory screen's panel links here for what belongs to no Memory on screen.
 * It takes no params: what it shows is the signed-in viewer's own list.
 */
import { SharedAnchorsScreen } from '../../src/features/memories/shared/SharedAnchorsScreen.tsx';

export default SharedAnchorsScreen;
