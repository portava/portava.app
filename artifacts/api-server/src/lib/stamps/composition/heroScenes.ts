/**
 * Procedural vector hero scenes — the fallback tier of the composition engine.
 *
 * When AI hero art is unavailable (provider down, QC-failed candidate, or
 * pre-generation preview), the compositor drops one of these deterministic
 * vector scenes into the art window instead. Scenes for the five launch
 * identities were approved in the 2026-07-23 composition prototype; every
 * other motif renders the 'generic' scene tinted by the identity palette.
 *
 * Each function returns SVG markup for a 1000×1000 viewBox, later clipped to
 * the stamp's art window.
 */

import type { StampPalette } from "./identities.js";

export function heroScene(motif: string, P: StampPalette): string {
  switch (motif) {
    case "tokyo": return tokyo(P);
    case "cebu": return cebu(P);
    case "paris": return paris(P);
    case "bangkok": return bangkok(P);
    case "iceland": return iceland(P);
    default: return generic(P);
  }
}

function generic(P: StampPalette): string {
  // Sun over layered hills — palette-tinted, deliberately destination-neutral.
  return `
  <defs>
    <linearGradient id="sky-gen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.background}"/>
      <stop offset="1" stop-color="${P.secondary}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1000" height="1000" fill="url(#sky-gen)"/>
  <circle cx="500" cy="430" r="170" fill="${P.accent}" opacity="0.95"/>
  <g fill="${P.highlight}" opacity="0.85">
    <circle cx="240" cy="230" r="6"/><circle cx="770" cy="200" r="5"/><circle cx="640" cy="140" r="4"/>
  </g>
  <path d="M0 640 Q250 520 500 610 T1000 600 L1000 1000 L0 1000 Z" fill="${P.primary}" opacity="0.85"/>
  <path d="M0 730 Q300 640 620 720 T1000 700 L1000 1000 L0 1000 Z" fill="${P.primary}"/>
  <rect x="0" y="840" width="1000" height="160" fill="${P.border}"/>`;
}

function tokyo(P: StampPalette): string {
  return `
  <defs>
    <linearGradient id="sky-tokyo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.background}"/>
      <stop offset="0.55" stop-color="#3D4E8C"/>
      <stop offset="1" stop-color="#8A5B7A"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1000" height="1000" fill="url(#sky-tokyo)"/>
  <circle cx="500" cy="400" r="200" fill="${P.secondary}" opacity="0.92"/>
  <path d="M120 720 L420 380 Q500 320 580 380 L880 720 Z" fill="#232C52"/>
  <path d="M395 405 Q500 330 605 405 L560 455 Q545 430 520 447 Q500 425 480 447 Q455 430 440 455 Z" fill="#F1EFF7"/>
  <g fill="#1B2340" opacity="0.9">
    <rect x="90" y="640" width="46" height="80"/><rect x="150" y="600" width="34" height="120"/>
    <rect x="806" y="628" width="42" height="92"/><rect x="862" y="596" width="30" height="124"/>
  </g>
  <g fill="${P.secondary}">
    <path d="M300 520 Q500 470 700 520 L700 556 Q500 508 300 556 Z"/>
    <rect x="330" y="548" width="340" height="26" rx="4"/>
    <rect x="368" y="548" width="34" height="240"/>
    <rect x="598" y="548" width="34" height="240"/>
  </g>
  <rect x="0" y="770" width="1000" height="230" fill="#151B38"/>
  <g fill="${P.accent}">
    <circle cx="220" cy="260" r="13"/><circle cx="268" cy="312" r="9"/><circle cx="180" cy="350" r="7"/>
    <circle cx="784" cy="240" r="12"/><circle cx="742" cy="300" r="8"/><circle cx="826" cy="330" r="7"/>
    <circle cx="620" cy="200" r="7"/><circle cx="380" cy="190" r="8"/>
  </g>`;
}

function cebu(P: StampPalette): string {
  return `
  <defs>
    <linearGradient id="sky-cebu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0E7490"/>
      <stop offset="0.5" stop-color="#2FB0BF"/>
      <stop offset="1" stop-color="#FBD38D"/>
    </linearGradient>
    <linearGradient id="sea-cebu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0E7490"/>
      <stop offset="1" stop-color="#065666"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1000" height="1000" fill="url(#sky-cebu)"/>
  <circle cx="500" cy="470" r="150" fill="${P.accent}"/>
  <path d="M240 620 Q380 560 520 610 Q660 560 790 618 L790 640 L240 640 Z" fill="#0A4A5C"/>
  <g stroke="#0A4A5C" stroke-width="16" fill="none" stroke-linecap="round">
    <path d="M370 616 Q360 520 330 470"/>
  </g>
  <g fill="#0E5F72">
    <path d="M330 470 Q250 430 190 470 Q260 462 330 492 Z"/>
    <path d="M330 470 Q280 380 210 370 Q290 400 322 478 Z"/>
    <path d="M330 470 Q360 380 440 366 Q370 404 340 480 Z"/>
    <path d="M330 470 Q410 428 470 462 Q400 456 336 492 Z"/>
  </g>
  <rect x="0" y="640" width="1000" height="360" fill="url(#sea-cebu)"/>
  <g stroke="${P.paper}" stroke-width="14" fill="none" opacity="0.85" stroke-linecap="round">
    <path d="M120 730 Q180 700 240 730 T360 730"/>
    <path d="M560 780 Q620 750 680 780 T800 780"/>
    <path d="M300 860 Q360 830 420 860 T540 860"/>
  </g>
  <g fill="#083A47">
    <path d="M600 690 Q670 712 740 690 L724 664 L616 664 Z"/>
    <rect x="664" y="596" width="10" height="70"/>
    <path d="M669 596 L724 640 L669 640 Z" fill="${P.paper}"/>
  </g>`;
}

function paris(P: StampPalette): string {
  return `
  <rect x="0" y="0" width="1000" height="1000" fill="${P.background}"/>
  <circle cx="500" cy="470" r="230" fill="none" stroke="${P.accent}" stroke-width="6" opacity="0.5"/>
  <g fill="${P.primary}" opacity="0.85">
    <rect x="90" y="700" width="130" height="145"/><path d="M90 700 L155 652 L220 700 Z"/>
    <rect x="180" y="666" width="10" height="34"/>
    <rect x="760" y="716" width="150" height="130"/>
    <path d="M835 626 A62 62 0 0 1 897 688 L773 688 A62 62 0 0 1 835 626 Z"/>
    <rect x="773" y="688" width="124" height="28"/>
    <rect x="830" y="596" width="10" height="30"/>
  </g>
  <g fill="${P.primary}">
    <rect x="490" y="150" width="20" height="56" rx="6"/>
    <path d="M478 206 L522 206 L546 470 L454 470 Z"/>
    <rect x="436" y="470" width="128" height="24" rx="6"/>
    <path d="M456 494 L544 494 L578 646 L422 646 Z"/>
    <rect x="398" y="646" width="204" height="26" rx="6"/>
    <path fill-rule="evenodd" d="M412 672 L588 672 L700 845 L300 845 Z M402 845 Q500 692 598 845 Z"/>
  </g>
  <g stroke="${P.background}" stroke-width="7" opacity="0.65">
    <line x1="466" y1="330" x2="534" y2="330"/><line x1="459" y1="400" x2="541" y2="400"/>
    <line x1="440" y1="570" x2="560" y2="570"/>
  </g>
  <g fill="${P.accent}">
    <circle cx="250" cy="250" r="7"/><circle cx="760" cy="220" r="6"/><circle cx="700" cy="330" r="5"/>
    <circle cx="300" cy="360" r="5"/>
  </g>
  <rect x="0" y="845" width="1000" height="155" fill="${P.primary}" opacity="0.16"/>`;
}

function bangkok(P: StampPalette): string {
  return `
  <defs>
    <linearGradient id="sky-bkk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7A2412"/>
      <stop offset="0.55" stop-color="#C2570F"/>
      <stop offset="1" stop-color="${P.accent}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1000" height="1000" fill="url(#sky-bkk)"/>
  <circle cx="500" cy="430" r="170" fill="${P.highlight}" opacity="0.9"/>
  <g fill="#4A1208">
    <path d="M500 170 L512 320 L488 320 Z"/>
    <path d="M470 320 L530 320 L548 400 L452 400 Z"/>
    <path d="M440 400 L560 400 L585 480 L415 480 Z"/>
    <path d="M400 480 L600 480 L630 570 L370 570 Z"/>
    <path d="M340 570 L660 570 L660 620 L340 620 Z"/>
    <path d="M300 620 L700 620 L700 700 L300 700 Z"/>
    <path d="M240 700 L760 700 L760 740 L240 740 Z"/>
    <path d="M255 560 L275 470 L295 560 Z"/><rect x="248" y="560" width="54" height="140"/>
    <path d="M705 560 L725 470 L745 560 Z"/><rect x="698" y="560" width="54" height="140"/>
  </g>
  <rect x="0" y="740" width="1000" height="260" fill="#3A0E06"/>
  <g fill="${P.accent}">
    <path d="M120 790 l22 -26 l22 26 l-22 26 Z"/><path d="M190 790 l22 -26 l22 26 l-22 26 Z"/>
    <path d="M746 790 l22 -26 l22 26 l-22 26 Z"/><path d="M816 790 l22 -26 l22 26 l-22 26 Z"/>
  </g>`;
}

function iceland(P: StampPalette): string {
  return `
  <rect x="0" y="0" width="1000" height="1000" fill="${P.background}"/>
  <g fill="none" stroke-linecap="round" opacity="0.85">
    <path d="M120 380 Q320 180 520 320 T900 240" stroke="${P.accent}" stroke-width="64" opacity="0.55"/>
    <path d="M80 460 Q300 260 540 400 T940 320" stroke="${P.secondary}" stroke-width="42" opacity="0.6"/>
    <path d="M160 320 Q360 140 560 260 T920 180" stroke="${P.highlight}" stroke-width="22" opacity="0.5"/>
  </g>
  <circle cx="705" cy="250" r="58" fill="#DCE9F2"/>
  <circle cx="685" cy="235" r="12" fill="#B9CFDD"/><circle cx="722" cy="268" r="8" fill="#B9CFDD"/>
  <g fill="${P.highlight}">
    <circle cx="200" cy="200" r="5"/><circle cx="850" cy="160" r="4"/><circle cx="600" cy="120" r="4"/>
    <circle cx="330" cy="130" r="3"/><circle cx="880" cy="420" r="4"/>
  </g>
  <path d="M40 720 L270 420 L420 650 L570 380 L790 720 Z" fill="#0F2233"/>
  <path d="M548 412 L570 380 L592 412 L575 430 Z" fill="${P.highlight}"/>
  <path d="M258 454 L270 420 L288 458 L272 472 Z" fill="${P.highlight}"/>
  <path d="M380 720 L620 510 L950 720 Z" fill="#132B40"/>
  <rect x="0" y="720" width="1000" height="280" fill="#0C1F30"/>
  <g fill="${P.highlight}" opacity="0.9">
    <path d="M140 820 l40 -20 l40 20 l-40 18 Z"/>
    <path d="M700 850 l52 -24 l52 24 l-52 22 Z"/>
    <path d="M420 880 l34 -16 l34 16 l-34 15 Z"/>
  </g>`;
}
