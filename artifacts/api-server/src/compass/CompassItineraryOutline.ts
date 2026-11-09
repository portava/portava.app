const numerals = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];
const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const indoorIdeas = ["Morning: choose an indoor museum or gallery. Check access with the venue before leaving.", "Afternoon: choose an indoor café or rest stop nearby, with time to return."];
const flexibleIdeas = ["Morning: explore one neighborhood at your own pace, with time to rest.", "Afternoon: choose a nearby public space or cultural activity after checking access and your budget."];

/** An outline for requested dates, built without claiming a venue exists or has space. */
export function itineraryOutline(prompt: string, city: string | undefined) {
  const count = new RegExp('\\b(\\d{1,2}|' + numerals.join('|') + ')[-\\s]+days?\\b', 'i').exec(prompt);
  const n = count ? (Number(count[1]) || numerals.indexOf(count[1]!.toLowerCase()) + 1) : /\bweekend\b/i.test(prompt) ? 2 : 1;
  if (n < 1 || n > 14) return null;
  const destination = city && city.length <= 80 ? city : undefined;
  const budget = /(?:[$€£₫¥₹]\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:USD|VND|EUR|THB|PHP)\b)/i.exec(prompt)?.[0];
  const allInside = /\b(?:all|every|both)\s+days?\b[^.!?]{0,24}\bindoor|\bindoor\b[^.!?]{0,24}\b(?:all|every|both)\s+days?/i.test(prompt);
  const days = Array.from({ length: n }, (_, i) => {
    const day = `(?:day\\s+(?:${i + 1}|${numerals[i]})|${ordinals[i] ?? (i + 1) + "th"}\\s+day)`;
    const indoors = allInside || new RegExp(day + "[^.!?;,]{0,28}\\bindoor|\\bindoor[^.!?;,]{0,28}" + day, "i").test(prompt) || (n === 1 && /\bindoor/i.test(prompt));
    return { label: `Day ${i + 1}`, highlights: indoors ? [...indoorIdeas] : [...flexibleIdeas] };
  });
  return { message: `Here’s a flexible ${n}-day outline${destination ? " for " + destination : ""}. I couldn’t verify specific venues from the available listings.${budget ? " Keep your " + budget + " budget in mind when choosing each activity." : ""}`, payload: { type: "itinerary", ...(destination ? { destination } : {}), days }, quickActions: [] };
}
