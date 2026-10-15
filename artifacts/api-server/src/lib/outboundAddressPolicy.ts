/**
 * Outbound address policy — the resolved addresses Portava's server may CONNECT
 * to when it fetches a URL a person wrote in a message (Telegraph §30A.8, census
 * T404 / T446; migration 3825; flag `telegraph_link_previews_enabled`, seeded
 * FALSE).
 *
 * PROVENANCE. Adopted, not rewritten: `isPublicPreviewAddress` and its two
 * block lists are the uncommitted Codex T404 work's
 * (`/Users/areyouok/portava-sandbox/wt-codex-t404`, `lib/mediaUrl.ts`), copied
 * under lead ruling LR-B58-3. They move into this module because
 * `lib/mediaUrl.ts` is a census-media file whose edit ages that census, and
 * because the Codex copy placed its `import` in the middle of that file.
 * Additions here, each named where it is made: the 6to4 relay anycast block,
 * and a zoned/unparseable address answering false instead of throwing.
 *
 * THE RULE. An address is connectable only when it is GLOBALLY ROUTABLE:
 *   IPv4 — everything outside the special-purpose blocks below (RFC 6890 and
 *          its successors, plus the cloud metadata/host addresses that sit in
 *          ordinary space);
 *   IPv6 — inside the global unicast allocation 2000::/3 and outside the
 *          special blocks carved from it. An ALLOW list for IPv6, not a deny
 *          list, because the dangerous IPv6 forms (loopback, unspecified,
 *          IPv4-mapped / -compatible, NAT64, ULA — which holds AWS's
 *          fd00:ec2::254 metadata address — link-local, site-local, multicast)
 *          all sit OUTSIDE 2000::/3, so none of them has to be remembered.
 *
 * Every DNS answer for a host must pass, not just the first: a host that
 * resolves to one public and one private address is refused, because the
 * transport could otherwise be steered to the private one.
 */
import { BlockList, isIP } from "node:net";

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], //        "this network"
  ["10.0.0.0", 8], //       private
  ["100.64.0.0", 10], //    carrier-grade NAT (also Alibaba's 100.100.100.200 metadata)
  ["127.0.0.0", 8], //      loopback
  ["169.254.0.0", 16], //   link-local (AWS / GCP / Azure IMDS 169.254.169.254)
  ["172.16.0.0", 12], //    private
  ["192.0.0.0", 24], //     IETF protocol assignments (Oracle's 192.0.0.192 metadata)
  ["192.0.2.0", 24], //     TEST-NET-1
  ["192.88.99.0", 24], //   6to4 relay anycast (RFC 7526) — added on adoption
  ["192.168.0.0", 16], //   private
  ["198.18.0.0", 15], //    benchmarking
  ["198.51.100.0", 24], //  TEST-NET-2
  ["203.0.113.0", 24], //   TEST-NET-3
  ["224.0.0.0", 4], //      multicast
  ["240.0.0.0", 4], //      reserved, incl. 255.255.255.255 broadcast
  // Azure platform virtual address (metadata / host services), in ordinary space.
  ["168.63.129.16", 32],
] as const) denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23], //    IETF protocol assignments (Teredo 2001::/32, ORCHID, …)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], //    6to4 — embeds an IPv4 address, which may be a private one
  ["3fff::", 20], //    documentation (RFC 9637)
] as const) denied.addSubnet(address, prefix, "ipv6");

const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");

/**
 * True when a RESOLVED address is one Portava's server may connect to for a
 * link preview. Anything unparseable — including a zoned IPv6 literal such as
 * `fe80::1%eth0`, which `BlockList.check` rejects by throwing — is false.
 */
export function isPublicPreviewAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return !denied.check(address, "ipv4");
    // The allow list also excludes mapped/compatible IPv4, NAT64, ULA,
    // unspecified, loopback, link/site-local and multicast IPv6.
    return family === 6 && globalUnicastV6.check(address, "ipv6") && !denied.check(address, "ipv6");
  } catch {
    return false;
  }
}
