declare module "tz-lookup" {
  /** Offline coordinate → IANA timezone lookup. Throws on invalid coords. */
  export default function tzLookup(lat: number, lng: number): string;
}
