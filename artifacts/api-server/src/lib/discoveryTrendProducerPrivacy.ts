export type TrendProducerPrivacyBlock = "protected_zone_policy_unreadable" | "protected_zone_filter_required";

export async function unfilteredTrendBlockReason(sc: any): Promise<TrendProducerPrivacyBlock | null> {
  try {
    const { data, error } = await sc.from("protected_zones").select("id").eq("active", true).limit(1);
    if (error || !Array.isArray(data)) return "protected_zone_policy_unreadable";
    return data.length === 0 ? null : "protected_zone_filter_required";
  } catch {
    return "protected_zone_policy_unreadable";
  }
}
