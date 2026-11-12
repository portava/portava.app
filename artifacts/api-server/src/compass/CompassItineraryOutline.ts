const numerals = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];
const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const indoorIdeas = ["Morning — choose an indoor museum or gallery. Check access with the venue before leaving.", "Afternoon — choose an indoor café or rest stop nearby, with time to return."];
const flexibleIdeas = ["Morning — explore one neighborhood at your own pace, with time to rest.", "Afternoon — choose a nearby public space or cultural activity after checking access and your budget."];

/** A named destination wins over the phone location. A device city supplies the
 * destination only when the traveler explicitly requests a local itinerary. */
export function requestedItineraryCity(prompt: string, lookup: unknown, device: string | undefined) {
  const match = /\b(?:in|around|trip to|visit to|visit(?:ing)?)\s+([^.!?,;\n]+)/i.exec(prompt);
  const named = match?.[1]?.split(/\s+(?:with|for|under|from|on|but|instead|while|keeping|starting|over|without|before|after)\b/i)[0]?.trim();
  if (named && !/\b(?:and|then|day|days|week|weeks|morning|afternoon|evening|here|my|this|the|budget)\b/i.test(named) &&
      /^[\p{L}\p{M}][\p{L}\p{M} .’'-]{0,60}$/u.test(named)) return named;
  if (typeof lookup === "string" && lookup.length <= 80 && prompt.toLocaleLowerCase().includes(lookup.toLocaleLowerCase())) return lookup;
  return device && /\b(?:here|near me|my current city)\b/i.test(prompt) ? device : undefined;
}

/** Bare retries refer to the last user request, even when its provider round failed. */
export function itineraryPromptForTurn(prompt: string, history: readonly { role: string; content: string }[]) {
  if (!/^(?:please\s+)?(?:retry|try(?:\s+it)?\s+again)[.!?\s]*$/i.test(prompt.trim())) return prompt;
  return [...history].reverse().find(turn => turn.role === "user" && turn.content.trim())?.content ?? prompt;
}

/** An outline for requested dates, built without claiming a venue exists or has space. */
export function itineraryOutline(prompt: string, city: string | undefined) {
  const count = new RegExp('\\b(\\d{1,2}|' + numerals.join('|') + ')[-\\s]+days?\\b', 'i').exec(prompt);
  const n = count ? (Number(count[1]) || numerals.indexOf(count[1]!.toLowerCase()) + 1) : /\bweekend\b/i.test(prompt) ? 2 : null;
  const destination = city && city.length <= 80 ? city : undefined;
  // The local template understands only these English constraints. Custom dates,
  // accessibility, dietary requirements, other languages and long trips stay
  // with the model, using the original prompt and one tool-free final round.
  const words = prompt.toLocaleLowerCase().replace(destination?.toLocaleLowerCase() ?? "\0", "")
    .replace(/[$€£₫¥₹]\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:usd|vnd|eur|thb|php)\b/gi, "")
    .match(/[\p{L}\p{M}]+/gu) ?? [];
  const knownWords = new Set(("please plan build suggest create give make help me my a an the travel trip itinerary outline visit visiting in around to for of at here near current city weekend day days keep indoors indoor inside outside outdoors outdoor all every both i have want would like with and limit budget spending spend maximum within under cap only " + numerals.join(" ") + " " + ordinals.join(" ")).split(/\s+/));
  if (!/\b(?:plan|itinerary|outline|weekend)\b/i.test(prompt) || !words.every(word => knownWords.has(word)) || (n !== null && (n < 1 || n > 3))) return null;
  if (!destination || !n) {
    const message = !destination && !n ? "Which city and how many days would you like to plan for?"
      : !destination ? "Which city would you like to visit?" : `How many days would you like to spend in ${destination}?`;
    return { message, payload: null, quickActions: [] };
  }
  const budget = /(?:[$€£₫¥₹]\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:USD|VND|EUR|THB|PHP)\b)/i.exec(prompt)?.[0];
  const allInside = /\b(?:all|every|both)\s+days?\b[^.!?]{0,24}\bindoor|\bindoor\b[^.!?]{0,24}\b(?:all|every|both)\s+days?/i.test(prompt);
  const days = Array.from({ length: n }, (_, i) => {
    const day = `(?:day\\s+(?:${i + 1}|${numerals[i]})|${ordinals[i] ?? (i + 1) + "th"}\\s+day)`;
    const indoors = allInside || new RegExp(day + "[^.!?;,]{0,28}\\bindoor|\\bindoor[^.!?;,]{0,28}" + day, "i").test(prompt) || (n === 1 && /\bindoor/i.test(prompt));
    return { label: `Day ${i + 1}`, highlights: indoors ? [...indoorIdeas] : [...flexibleIdeas] };
  });
  return { message: `Here’s a flexible ${n}-day outline${destination ? " for " + destination : ""}. I couldn’t verify specific venues from the available listings.${budget ? " Keep your " + budget + " budget in mind when choosing each activity." : ""}`, payload: { type: "itinerary", ...(destination ? { destination } : {}), days }, quickActions: [] };
}
