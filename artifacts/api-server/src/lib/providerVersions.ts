import pins from "../config/providerVersions.json";

/** Build-time version pins, promoted by verified release events + CI. No network
 * lookup on user requests; history keeps already accepted generation jobs valid. */
export function providerModel(provider: string, baseline: string): string {
  return pins.models.find(pin => pin.provider === provider && pin.baseline === baseline)?.current ?? baseline;
}
export function approvedProviderModel(provider: string, baseline: string, model: string): boolean {
  const pin = pins.models.find(pin => pin.provider === provider && pin.baseline === baseline);
  return !!pin && [pin.baseline, pin.current, ...pin.history].includes(model);
}
