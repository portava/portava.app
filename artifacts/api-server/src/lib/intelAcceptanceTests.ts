/**
 * §28 ACCEPTANCE-TEST REGISTRY (spec Table 36, AT-01 … AT-18).
 *
 * WHY A REGISTRY AND NOT JUST TESTS
 * =================================
 * Every one of the eighteen acceptance scenarios has real coverage in this
 * suite — but until now only four of them (AT-04, AT-07, AT-10, AT-14) said so
 * in their test name. The other fourteen were covered by tests named after the
 * MODULE they exercise, which means the coverage was real and invisible at the
 * same time: nobody could answer "is AT-11 still tested?" without re-deriving
 * the mapping by hand, and a rename or a deletion would have silently dropped a
 * spec-level guarantee with no signal at all.
 *
 * So the eighteen ids live here, with the scenario and required assertion
 * verbatim from Table 36, and src/test/intelAcceptanceTraceability.test.ts
 * asserts that each one appears in at least one TEST TITLE somewhere in the
 * suite. That is a deliberately weak claim — it proves a labelled test exists,
 * not that the test is correct — but it is exactly the claim that rots
 * silently, and now cannot.
 *
 * HOW TO SATISFY A NEW ID: put the id in the title of the test that actually
 * asserts it, e.g. `it("AT-11: a cohort below the movement threshold mints no
 * claim", …)`. Never in a comment — the traceability check reads test titles
 * only, precisely so that a comment cannot stand in for coverage.
 *
 * PURE DATA. No imports, no runtime behaviour.
 */

export interface AcceptanceTest {
  /** Table-36 id, exactly 'AT-NN'. */
  id: string;
  /** Table-36 "Scenario", verbatim. */
  scenario: string;
  /** Table-36 "Required assertion", verbatim. */
  requiredAssertion: string;
}

export const INTEL_ACCEPTANCE_TESTS: readonly AcceptanceTest[] = [
  {
    id: "AT-01",
    scenario: "Expired crowd claim",
    requiredAssertion: "No Live label/read-model/API response uses it after valid_until",
  },
  {
    id: "AT-02",
    scenario: "Official 'open' but users denied",
    requiredAssertion: "Official state and functional unavailability coexist",
  },
  {
    id: "AT-03",
    scenario: "Rooftop packed, ground floor quiet",
    requiredAssertion: "Two zone snapshots; no false conflict",
  },
  {
    id: "AT-04",
    scenario: "Three copied reports",
    requiredAssertion: "One independence cluster; no consensus inflation",
  },
  {
    id: "AT-05",
    scenario: "Old video uploaded",
    requiredAssertion: "Cannot qualify as live evidence",
  },
  {
    id: "AT-06",
    scenario: "Contributor posts after leaving",
    requiredAssertion: "Observed time retained; current location not exposed",
  },
  {
    id: "AT-07",
    scenario: "Material conflict",
    requiredAssertion: "UI/API returns conflict and reduced confidence",
  },
  {
    id: "AT-08",
    scenario: "No live evidence",
    requiredAssertion: "Compass says unknown/historical; never 'live'",
  },
  {
    id: "AT-09",
    scenario: "Correction accepted",
    requiredAssertion: "All dependent snapshots, caches, alerts and explanations invalidate",
  },
  {
    id: "AT-10",
    scenario: "Blocked user follows Trail",
    requiredAssertion: "No direct or indirect location/room visibility",
  },
  {
    id: "AT-11",
    scenario: "Movement cohort below threshold",
    requiredAssertion: "No movement claim emitted",
  },
  {
    id: "AT-12",
    scenario: "Sponsored venue mission",
    requiredAssertion: "Funding labeled; negative valid result remains accepted",
  },
  {
    id: "AT-13",
    scenario: "Negative mission result",
    requiredAssertion: "Paid if evidence contract satisfied",
  },
  {
    id: "AT-14",
    scenario: "Hard accessibility constraint",
    requiredAssertion: "Ranking cannot override it",
  },
  {
    id: "AT-15",
    scenario: "Token-injected QA attempt",
    requiredAssertion: "Rejected; only real password-auth QA path allowed",
  },
  {
    id: "AT-16",
    scenario: "Private media observation",
    requiredAssertion: "Excluded from public feed/read model/API",
  },
  {
    id: "AT-17",
    scenario: "Processing/failed media",
    requiredAssertion: "Never appears as qualifying evidence",
  },
  {
    id: "AT-18",
    scenario: "Flag disabled",
    requiredAssertion: "Safe fallback without deleting data",
  },
] as const;

/** The id pattern a test title must carry to count as labelled. */
export const ACCEPTANCE_TEST_ID_PATTERN = /\bAT-(\d{2})\b/g;

/** Every registered id, in Table-36 order. */
export const INTEL_ACCEPTANCE_TEST_IDS: readonly string[] = INTEL_ACCEPTANCE_TESTS.map((t) => t.id);
