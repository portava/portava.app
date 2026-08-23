/**
 * Single source of truth for every frozen/archived migration root in the repo.
 *
 * Each entry is a directory that is NOT the canonical migration chain
 * (artifacts/api-server/src/migrations/) but historically or currently holds
 * migration-shaped .sql files. Every file's sha256 is recorded so the guard can
 * detect in-place content modification, not just filename additions/removals.
 *
 * Generated 2026-08-18 from the live tree via:
 *   find <root> -maxdepth 1 -iname '*.sql' -printf '%f\n' | sort | while read f; do
 *     sha256sum \"<root>/$f\"; done
 *
 * Imported by checkFrozenDir.ts. If a new frozen root needs to be added, add it
 * here - never as an inline copy elsewhere.
 */

export interface FrozenRoot {
  /** Path relative to the repo root. */
  relPath: string;
  /** Human-readable reason this root exists / is frozen, for error messages. */
  label: string;
  /** Bare filename -> sha256 hex digest, for every .sql file known to exist here. */
  files: Record<string, string>;
}

/**
 * A non-canonical root that is deliberately EXEMPT from the unlisted-root
 * sweep by name — unlike FrozenRoot, its file SET is not hash-pinned,
 * because its contents are expected to change over time (new baseline
 * captures added; staged migrations added/removed as they're
 * reviewed/applied). Being allowlisted is not being unwatched: it is on
 * this list explicitly, with a reason, and removing an entry here re-arms
 * the sweep against it immediately.
 */
export interface AllowlistedRoot {
  /** Path relative to the repo root. */
  relPath: string;
  /** Human-readable label, for status/error messages. */
  label: string;
  /** Why this directory legitimately holds migration-shaped .sql files. */
  reason: string;
  /**
   * true: this root's .sql files must NEVER overlap (by filename OR by
   * content hash) with the canonical migration chain — enforced by
   * checkNonExecutableOverlap(), not merely documented. Use for artifacts
   * that must never be replayed as a migration under any circumstance
   * (e.g. a schema dump). Use false for a working/staging area whose files
   * are EXPECTED to eventually be copied into canonical (e.g. a
   * review-staging directory) — for those, overlap is the intended
   * end state, not a defect.
   */
  nonExecutable: boolean;
}

export const ALLOWLISTED_ROOTS: AllowlistedRoot[] = [
  {
    relPath: "reconciliation-staging",
    label: "P0 review-staging area for proposed reconciliation migrations",
    reason:
      "Working area, not a frozen historical root and not canonical: its .sql files are proposals awaiting owner review/apply; once applied they are committed into artifacts/api-server/src/migrations/ (the canonical chain) and removed from here, so content changing over time is expected and must not fail this guard the way an edit to a truly frozen root would.",
    nonExecutable: false,
  },
  {
    relPath: "artifacts/api-server/baseline",
    label: "Schema-only production baseline snapshots",
    reason:
      "Non-executable artifact: a point-in-time pg_dump captured for reconciliation reference, never a migration to run — new dated captures may be added over time, so this is allowlisted by directory rather than hash-pinned to one file. checkNonExecutableOverlap() below additionally fails the build if anything here is ever copied into (or shares a filename/content hash with) the canonical migration chain, since a baseline dump run as a migration would be catastrophic.",
    nonExecutable: true,
  },
];

export const FROZEN_ROOTS: FrozenRoot[] = [
  {
    relPath: "artifacts/api-server/migrations",
    label: "Legacy migrations dir (no src/) - frozen 2026-07-17",
    files: {
      "0011_trip_plan_coords.sql": "0a92743ef71fb23d336c2b80eab309d6f61fb95c7924717f29ee2504f4a3752e",
      "0012_group_chat.sql": "c7277c18c9e9b68dfcf35be19630ca148cfee9f569d4bfc56246178e1944f0c0",
      "0013_availability_meetups.sql": "839637a60973fdbb7537718415e53ad9bc3ad4dd62be090302efea88412bfd25",
      "0019_proposed_time.sql": "7cba41bf67461591d40417bb19c3ebf5bccdf55814f37b0108d2fe6294854d8e",
      "0020_notifications_inbox_viewed.sql": "ad08656081ce0adc2b0500291f5e24aeeed4efd1802646e2f25e1387cc5e95f2",
      "0022_availability_nudges.sql": "83874715ec843578b180da2c88af7f8bc017839ba189de45e968947b1d8de40f",
      "0023_push_tokens.sql": "ef1fdc34c3296dd717c4020798e1eb5206301acaaef1ddfdc135cf7a979c33f6",
      "0024_post_engagement.sql": "7fb7a7db3ad03adc798e4101d9bf71bae9594bd7d986dfa5f630034590ec2c4a",
      "0025_location_system.sql": "06736441f4d249ca3e0469efcd46a7d003ab01d4cd9c17134b65b719bcceaf4e",
      "0026_highlights.sql": "46647353bcb954751d9235fadcc460a7fed63f65d09ed7304158de81874ed0fb",
      "0027_verification_status.sql": "01911792aadda935aa6552162371fac5d7b31750543d889555d1806a0a80a7d8",
      "0028_highlights_last_viewed.sql": "fa3da40613e9ceedcb82ef3bdcd8fe3f81e13dbf63f59ac8a0d174a79b64accf",
      "0029_discovery_places.sql": "02b86c95966b8d430fd57ce5f0aa1f24e48d47abb87664f26f25c4432ad49060",
      "0030_message_reports.sql": "9a0ab29030e2df407d78995e6d10caa4a62ba7d74f97ebb9b547b6ad70223fb8",
      "0031_thread_reports.sql": "0ec61ca4596be150e62afcbb4e5e1d869b12cd498b33ff98b850a17d68285a8f",
      "0032_location_preferences.sql": "3af5ee8e199d877b1d9619478e276264506be43d723385bde87d7f505cfda0b2",
      "0033_location_sessions.sql": "03065682d1e62f49cd276c2275701844edf9d23d2c6555ea3029e6c66e5ae911",
      "0034_geo_zones.sql": "6da1476b48d706152a66d8ed278a741a7c3863e5d5f2fbde174b27831d509e45",
      "0035_plan_geofences.sql": "b8249408e45ea58848d282380a388a6f3ffab758a339dc12335f69fa893994f6",
      "0036_pulse_geo_tags.sql": "49b5652e07ff1a186963169a4c590a28aaa238a5d6b70168048e6b23218dcfac",
      "0037_feature_flags.sql": "152675abbc5a4aed2afa75c69a04b24e493c88c710411fb8da182f0b8640e4ad",
      "0038_plan_geofences_rls_fix.sql": "ae57907ed5f725403230b138e0c278a5d4a868a904138eca590063dd18fd8d98",
      "0039_plan_geofence_full.sql": "6c8b0436add472d727013142b8de775b84ce9109c817833209afaf621280856a",
      "0040_safe_return.sql": "463e2082b04ff6b662420cec7a9689105dfe1c9be07cfb602b7b653a457c0a7a",
      "0041_notifications.sql": "c13eee4ea40545f6fa32ce18af008619db5e20c0f6002c69896c61dc4a264bfb",
      "0041_trip_crew_location.sql": "d8bac407740bade37315e1132fb572a1283898c01dc50400aed31373d7fe184c",
      "0042_passport_stamps.sql": "69c8e78a2724590d163fd402ee6b035d1d6618b532ed110a8a990f2426a92338",
      "0043_trust_engine.sql": "18b699bd60a6c10d91e10df2ae6379c54c7f86f4ac02eca130e5661ff8561294",
      "0044_airport_layover.sql": "2da208c71c28736620027dd1d9bea7fc63eafa6899131ed6e2711abf52664e30",
      "0044_hashtag_reports.sql": "c1f0065b4898fb483aa79ff8ea8287c67d53a933469c0d0c2a9bfe425a5d1a2f",
      "0046_tag_suppression.sql": "6bc5d3fce30638276be4b2daedc6077df5098af432cd80d6524f86c55bb7cbf1",
      "0047_rent_buddy.sql": "b6f63d2d08aa1adb37a2463666fe3041dc1efa04c50c448c64c5737a8a1b24c2",
      "0048_rent_buddy_marketplace.sql": "a330a126c3f09cefac7c57bdf417720bd18defd3b009e14217422b6f965f2bc8",
      "0048_rent_buddy_rollout.sql": "5a1605c7805f3c4b2fb2d3f874a4a470b0aa199dc5270f812673a010d02a59ee",
      "0051_rent_buddy_compliance.sql": "0f50f6604e785378b4f9bfbd74621a3fc99ced73c09bcaa7dd3a70f45878ab6b",
      "0055_compass_admin.sql": "25639422c0d72d1509a2c32dfc5a04cde62259006408170f11c1128c02fa93bd",
      "0062_discovery_place_saves.sql": "5d167868126adab5a4cd0939806c9be4c394cdf6ee29b13fe27555273fcfce67",
      "0063_push_retry_queue.sql": "a966c0d4391e428f35c485ecffa9a4718238b53af396b720a4a05945a271c614",
      "0075_stamp_artwork.sql": "3300d298fca23ffc57b15721e18da7ced023b42aad5b66bd2eebb7866020942c",
      "0076_profile_emergency_contacts.sql": "83e4ebd7bebee61741bafb270b725098c791e07360f12ed19612fb0a401d4d4e",
      "0089_decrement_discovery_place_saved_count.sql": "37177bbb2de3d1ba38d8ba4992de8a530d1d4ed3430d4a248d079f36ccb3becf",
      "0093_activate_stamp_definitions.sql": "77c474180945e70eec384afdae0f32ec86c2008ab733056df11f5b041948cc86",
      "0094_profile_account_status_and_privacy.sql": "63e09c09924f944dc52e659c0aa3288c38a0dd62c159af626b444608873a9e3b",
      "0095_post_category.sql": "7a93d0a9a9c841ce5005e2cb3788b085486f60516c7262f5ec5c77f117fabd71",
      "0100_backfill_display_name.sql": "7a5b0a5d62c4d1edea7e2e663fa64c8ccc5188ae035e9ab43fbcf087c239602b",
      "0102_show_real_name.sql": "204ecea38510b3e1a6c299b41b58753721304e1f84ef124d2b66f2c0f3ee6268",
      "0107_rent_buddy_admin_actions.sql": "cf8a72527ec957a576d3733e30e62350e8aae564f3b8c619e4323bd249f021dc",
      "0108_rent_buddy_spec_tables.sql": "9478402a5d21231c41bf66cec7b15e57136b6b55435415eb6872a80a494e841d",
      "0109_rent_buddy_missing_enums.sql": "361b7fbdd97cd5e08255bea3fad9946b6fc290abd1e732a7f66048df6f46cf44",
      "0110_rent_buddy_payouts.sql": "10807b99f8b5d8a1d416bb5a065de3ea96908730ec2e52beac108d47c39a303d",
      "0111_rent_buddy_onboarding_ack.sql": "3cd9c526ea9fafd06115bae62a2a4fe0a11fc701907067f9203565df5300bd9e",
      "0112_rent_buddy_lifecycle.sql": "1f04a1b5363d5c4c9e622e5e564aec4d1faf18402655c532babd8eb8304184e0",
      "0113_rent_buddy_lifecycle_fixes.sql": "a09d9591cc30c9d9028232148465b04cf28a6f6c14ee5f69d742512f747d1b5e",
      "0114_review_moderation.sql": "ccdf5f74fccf506aed2ef7526cb542c69b5452886404a831baf5f186898fb158",
      "0115_circle_visibility_settings.sql": "799c6bc376210ea7613878a303c59f814f3982b0f0d641ab88e641fba65aae0b",
      "0116_circle_context_settings.sql": "8831fd8f87f2018ded22bf4b80111bb79f1557954bb1bd9833aa05030b8b4b49",
      "0117_circle_presence.sql": "5b8c31788bb944cbec676b2936d87dc7386126b1c0e0630cdc3be0299b9f962d",
      "0118_circle_checkins.sql": "efc3018a25d57e3c7ac1d22881812838e76244bd83abc4b1b6051d9149a9b3df",
      "0119_circle_member_visibility_overrides.sql": "145507a24ca025efd935ed8555cb8c4f37cf5850b815db07f35d68f529d9a496",
      "0120_circle_meeting_points.sql": "32edb6d1d267303abe67705f8e269f7370c974e43717b820faf07e99a5fc4f88",
      "0121_circle_audit_events.sql": "c4c00071cd6754b245f73f2a90e4879d504a6bdbc20ccafd3b647c83ca55074e",
      "0122_circle_global_pause_and_defaults.sql": "3a2db14c8d74c802db01ab552a31ecd0564acd5cd38a81ac0214674f1d5044d2",
      "0123_engagement_user_indexes.sql": "c9901a54cd4f79e1a927223478219b50b793a2da3cdef58f4782cf0d04f16d31",
      "0130_rent_buddy_place_coords.sql": "1fd62dcbb202fe3d8c10bfeb95cfdf1dcc94260c5ecd335fcb99e62d87ac1c0b",
      "0134_rent_buddy_schema_rebuild.sql": "ac8de37e2696d4395577e3cb8a70152dc1c628450896cd08e2da04513385e305",
      "0135_rent_buddy_reliability_counter_functions.sql": "c0e2f49b481f67b69cd7ca66d93b2844d1a6c936c005d37fb17da99355cb1671",
      "0138_city_country_geocode_cache.sql": "69936db9bf8f9b81c3e729195d906b9f7253f20e3fbde1eadd513df43f891f76",
      "0139_geocode_cache_corrected_at.sql": "4fe532000a7057fb5f003745fc2db70c79c0d8ea7707291d6d4a27f654b2a9ae",
      "20260620_telegraph_intelligence.sql": "90cf4572b54bf201a8b0b1669bc100c194f4bbb55945d08434c9b6036edd2c02",
      "20260621_weather_cache.sql": "c0bfd54410a58dddcbc8018878415a49afd6e70a9aeb6290ca632b6584308b6c",
      "20260702_crew_location_flags_reseed.sql": "52dba925cd670bbcf7651d02c2b3012bc32a0283f242162f1e5d798c29a2ead1",
    },
  },
  {
    relPath: "migrations",
    label: "Repo-root historical migrations dir - archived 2026-08-08",
    files: {
      "0001_spine.sql": "35f2d5a92ebb1b30d87a08f6401b6950640123ba491227b780d452a9b443e48c",
      "0002_map_privacy.sql": "d395b34158640bc79ed06541765a6b92330e6a88f8bc846b34b8ce87c1bf8410",
      "0008_messaging.sql": "075f8caf1ece561424cacf22c5a7e90fbdcd92d0489ece25414d89cf310ccc5f",
      "0009_translation.sql": "32fe5e48b5c5e12196386ec8ed117ffcf619d8a69c62d93e815aaad85f6ca5f5",
      "0010_group_chat.sql": "38db99f4c1eace30d0f173ba53952b9d28ff0a9688321bd0cf3e9df8d70836a8",
      "0011_telegraph_chat.sql": "2cfacd190231b3c7879982e933981fd391575baad611efde0aa8676c3e346cbe",
      "0012_intelligence.sql": "84ccd2e6ae8f1b45fcab538e8ba3d45402bf24fee866a6db91af037b36a1f474",
      "0013_availability_meetups.sql": "ac4b85086cca087d9da0c0936bfb8c85c5ca5071b11234d65e6c869f484d6d78",
      "0016_thread_reads.sql": "d5d7f401bd4b617c0710152d6bf6661105ccd37d7df809e500aa648500c45159",
      "0017_job_health.sql": "45d3232ffe85bbcf42d1e6f57c44c8c0bc763122733cfba88046fec1118c8734",
      "0018_preferred_language.sql": "dbd55423b0e3f1290c3aefc8625a2c67c20de97f77ee7019c2d1cc457187df65",
      "0028_highlights_last_viewed.sql": "02a882d2d7678ac74b4465ace76d9fb73906edc75985761e4ab3a7c259ed822f",
      "0029_discovery_places.sql": "02ae1a7dc35dcca01e91c829130221bbe87619dcd0b326d481c646162c565ac7",
      "0032_location_preferences.sql": "68f942a3c045ba519c9d1184bb9d2e0ba6fe39c89520a16d0737463a181ab528",
      "0033_location_sessions.sql": "2fe254ba24290e70be00596a10dd4310bc32e727df3be5d74f11b49354a145ba",
      "0034_geo_zones.sql": "d4c86c1a9fca708de87204e7c231a3829d594e441f835adc4046adbf7b703caa",
      "0035_plan_geofences.sql": "dfacec650ae1561d56af3ecc7ea5e13bf5bacb9fd17cfe9f11d5056195dd96d7",
      "0036_pulse_geo_tags.sql": "ee765f1e0828665a92be9baf61d1720ad9ff254797899b79684745b0cf5ef8cb",
      "0037_feature_flags.sql": "2a4799f195bc293204e5814cd6926f77f9be64719afa79e5aa3d09fa9aad055a",
      "0039_plan_geofence_full.sql": "2320b24f3e770b8eb553dc01278d101ee37fb7522f7f6e7c61bcb3125c121176",
      "0041_trip_crew_location.sql": "5f6b31cbe05589ea3760ddad46a1fbdda6e89591ccc71f8cb60a5b3ce14b34ce",
      "0042_passport_stamps.sql": "b7c63593115afcdf8bb985c2e0a93c7954147b81d7a87f018644d49577f9b7bf",
      "0043_tags_hashtags.sql": "bd577f0cc6432b340d9127bc658f1ed487140d3840155c9871dededd655932ac",
      "0044_hashtag_reports.sql": "7a708cef11c9ede0557da2aa7aff0ff1d143d8520e0e806d0b2b3f2810c8a306",
      "0044_tags_hashtags_supplement.sql": "f9370f97d95980a746634bf6f682dcca4233c38943c8c76b7ff056a9771b8595",
      "0046_tag_suppression.sql": "7d43a5284bddf40e5a746c2fb59d10dcf5872072cfb3463553818fe2706eb5e0",
      "0047_rent_buddy.sql": "24a6383d7c01ed55c584d98dba620dc1c2293a0f25bda13abb44ef88cb91b63a",
      "0048_booking_stay_connected.sql": "03be832fe223a05073e5de95b5bceee3c4bd00b41e89daeef0d910b545a80979",
      "0050_suggestion_seen.sql": "d08a87260e38f8c34ad259f2c4dedce70aa387b08d18dd5c1af63a2c78db4461",
      "0051_trip_members_user_role_idx.sql": "82c08ae429d639102628d7e61b47b511ee805987d25b7b10bae3807ad82409ec",
      "0069_reviews.sql": "6a2c109371c484df4ae5ba7b3711e6367d0875748dd7d3676ae771ae5cad5e54",
      "0070_appeals.sql": "6cd1da2e5822ca1be423634394e9f8b31eed28811d4119c768e3ead21944f3b9",
      "0124_trip_crew_location_sessions_drift.sql": "575c26ec567df186cf2688667a763edc9aff5c3b2c807a74a7f10460a5c75dc5",
      "APPLY_THESE_IN_ORDER.sql": "6b04af38c00006516afcd5aff6445db7bc9a9c20476a29b388e04301061e2bcc",
    },
  },
  {
    relPath: "supabase/migrations",
    label: "Repo-root supabase/ - self-documented archival, not a live CLI project (see supabase/README.md)",
    files: {
      "0015_blocks.sql": "c3b2b4e6ddf6b836c6f5bafe755b6a8c03994ba14f052104094c3793199e3fe8",
      "0018_preferred_language.sql": "6ed2dade5aeee3993cb70dd0db393d3d5b44e7971e9cb31ff5140d695b6da118",
      "0025_media_filters.sql": "280df01499daafa5fae0f4a0a67e63ca46763bc230f4ef7bf938336bd5e6dfcf",
      "0048_booking_stay_connected.sql": "752c30f2fbf94a3de01d6a6ebee55cfc8eca25cd2a8e0ab916c2b05becfcd9bd",
      "0049_delayed_geotag_posts.sql": "22b498bac3ec37926825887639ca4af10d8a0bffec71e0dd65f0181707c5d640",
      "0087_profiles_cover_photo_url.sql": "2a222a1c688fff23d3d2841001f4c02693cf56c54279bffafae5d46766664497",
      "0101_search_history.sql": "b2d0dafae85e0b722660c18cb361e5c7a4dae931903e46d58ba471d702705b3b",
      "0102_universal_stamp_catalog.sql": "313b9496fe5fd57e994d6ca898c6d056ae03a5aa46c3a518a35b94dfa6352802",
      "0103_idx_posts_location_place_id.sql": "2048c409ea1bb700dfe2f7bfd97a1931722df875c6678da16ce927f3f260ba4b",
      "0104_idx_discovery_places_osm_id.sql": "34bcef2e24d0eaf51647844984259acac1d560273ce93d2238b0cf41d021f507",
      "0105_hidden_gems_trip_id.sql": "2cc7534a0e1a07ef1484657834b411cb54c607f62d119b4146b27d747600e02a",
      "0106_profiles_is_official.sql": "6c734ee3a47725a5eef04f53c27c4775ea147cb4b4d0e0546f01acdd324464a7",
      "0107_portava_featured.sql": "c4fc7bbb67c112edf6a7865f359596fb4a34b9dad235ae6aa2fca9c95cac54e3",
      "0108_portava_post_category.sql": "1928eb91b3c2338f21b10bf4668b0e7f06618c951b862f7aa2740a2db592b872",
    },
  },
  {
    relPath: "artifacts/api-server/supabase/migrations",
    label: "supabase/ nested under api-server - live commits through 2026-08-13, never audited or documented as a tree; frozen here rather than left as an unlisted fourth stream",
    files: {
      "20260719_unique_open_group_room.sql": "128401ae1bd04bde3120114714a89b6d499cbb6fc877bb4916bdef7db3772ff6",
      "20260726_compass_ranking_factors.sql": "45c618ce799142b19cf73bdcc0da4ef2f2a72dbababb047c2d90b96a61b4182c",
      "20260801_ranking_discovery_foundation.sql": "0d609e9244269da9f96c837c6abe20d807fe437220218150569ce704c94d1ef8",
      "20260802_image_dimensions.sql": "d57d5b59d86ebc104121e188ae1e6d30534cb61d8cbd1ec255c7e11618a043be",
      "20260804_creator_fatigue_expires.sql": "055b8f5753ac70024efa766684435ab802ed73384ec617afea9282ee56210e3f",
      "20260807_hidden_gems_feed_columns.sql": "5bf0756e0b80049ec14245fb1a839819cf44b9691bc1005f8d5cbf4fc6df10d1",
      "20260808_place_votes.sql": "4bccd4585b4b3aacc627630287ef60b5b439cf30a6132bb2460ae2a924f4468d",
      "20260809_portava_publisher_boost_flag.sql": "c4ea7beeefc9bf6f6ad0049be7cca820d471d383787e3d5d79e0d9981d701c22",
      "20260810_content_translations.sql": "d2ce96964eae70f2fc83d433e9bf379c3c50b83f49159172e32a889f9ad6e83d",
      "20260811_count_content_stamps_received_rpc.sql": "8c55823fb7d7352bff87f286af78226b1fe83d8246c48802f50197f200fc1167",
      "20260812_compass_search_signal_log.sql": "324ab2a093f411de213741cdb27b867ac7bcfb6f95221a4499e4e9707cfd3bb7",
      "20260813_rent_buddy_policy_accepted.sql": "71b9b2b19b3d3a16c3e0e689618de6cfef8b375b6e44f8b52aba04187d93af8a",
    },
  },
  {
    relPath: "docs/sql",
    label: "Documentation copy of early migration files",
    files: {
      "0036_pulse_geo_tags.sql": "3f7ab968549ead08149e7ff6687bd43e5ff88dc13c52a38ea4fb8645abeed0bf",
      "0060_discovery_places_coords.sql": "356b79ffe60712edfa380f5abca39128bd99379beac91d5cf892a582bec62d0e",
      "0062_user_privacy_settings.sql": "5e7ca11f391212ebc70b704429a8c9fefc7379fc3e5ba79e186fa5d18de4b78e",
      "0063_user_account_states.sql": "73f8b990f170810c380497aeb9e5c63d2f7737e487f122268278b74e1bd01d74",
      "0064_user_mutes.sql": "dd67d31594860a705191b340bbbc5675e8a7f790f53a17916a8eda04c257a888",
      "0065_user_restrictions.sql": "9bedadcaf4f617f5104caf5a7dbbd228a608781ef9300249c6dbb8310c009905",
      "0066_user_interaction_audit_log.sql": "407b7198350363a49cb513d11d8be04ec8c3a741b1b4e4746a6a0608ba342e6c",
      "0067_moderation_actions.sql": "dda1e0036a6da995c2a7f0e51665961fffc09491e471111e7a5c01d4a4390c7e",
      "0068_user_interaction_cooldowns.sql": "9dac6b9e5edce7c4fcf547671cc7206338fc826bfbefd7e48fcc30f33cc24c32",
      "0069_user_social_consents.sql": "0882471060a77bac0874f85dd1cadd41c0f18531afdd802c26c708e37fbc016e",
      "0070_user_hidden_recommendations.sql": "a4686b0e2593598c1df594789dad5e015e20f4d152a61cfc25231819ee0f6953",
      "0071_reports.sql": "1ad8ff45ae8326bee26b6bcb2a737da21a96ed8b66c75cc80dfa1a62410176e7",
      "0072_report_evidence.sql": "41c81b5cca5916057682e6dec3a12c339353a80e1655d70cba9ce986758569ba",
    },
  },
  {
    relPath: "docs/migrations",
    label: "Documentation copy of early migration files",
    files: {
      "0065_events.sql": "6093fb2c0576e0dc3c0d1d9e322051376882110e4e9a0285810cbfa9e304d541",
      "0067_memories.sql": "2b9b665aaaf28b56da51a3d2a3d3cbfd4eddfb5fbb5aba41c6bd877475bc7664",
      "0068_stories.sql": "0435ce4cee04e2e16ee3de42999d8a807e61ebeeeaabfd8353f1510945645656",
      "0069_profile_privacy_settings.sql": "408dd34b8519f67c9dff605241658c76acfda5ba416d9d624f94e39a84fc4020",
      "0070_profile_views.sql": "052d0586d799ce31b908ab118ba6b6e72e89370b01437cb8b7308707f3823427",
    },
  },
  {
    relPath: "db/migrations",
    label: "Pre-consolidation scratch migrations dir",
    files: {
      "0024_post_engagement.sql": "3aa629e6e455b4e1af244e5cf4e4eb2264e588271e28d5ce4f3d14d7fd3181cc",
      "0025_location_system.sql": "c84c87f488f21ac4cc5c3a883a465eb80ef3db23370d41df60dcaf6afccc2ac5",
      "0027_recent_places.sql": "5011183c84ec74a9125e39926b84b0eaf850e197423a39b88d758cef297aaae0",
      "0161_identity_verification.sql": "3726908eefd452e32373f115a53dcf47677dd16361b586813e47af49cd6edcd0",
    },
  },
  {
    relPath: "travel-buddy-standalone/migrations",
    label: "Mobile app's own migrations dir (pre-consolidation)",
    files: {
      "0001_spine.sql": "35f2d5a92ebb1b30d87a08f6401b6950640123ba491227b780d452a9b443e48c",
      "0002_map_privacy.sql": "d395b34158640bc79ed06541765a6b92330e6a88f8bc846b34b8ce87c1bf8410",
      "0063_interaction_foundation.sql": "c428bd3085dc91b741a2d48a5bedb254ec76174504650dbf8672167c32093d7a",
    },
  },
  {
    relPath: "files/artifacts/api-server/src/migrations",
    label: "Patch/zip extraction staging copy",
    files: {
      "0180_activate_event_category_stamps.sql": "5d8157ff34b3ee636721f36691868e71372c301a9c0dbbf28a211fd79da8c063",
      "0181_stamp_unified_view.sql": "a1ef8cc7abe0f155488b4ec506afc52921937f00924c1f6adaded1a9f4d24d41",
      "0182_country_essentials.sql": "6e510436062f83cfdbd9416605b4895d76849b42c79fd28450115601ab0dde1d",
      "0183_budget_fx_conversion.sql": "6ae9a25ebfeea644f21caf490998ad221de18d89b22b3fff9be83afbb513b5ef",
      "0184_fsq_places.sql": "d47341e7ce50855a8c7aa4388a901393186adfed097f7a45d3d29fa0b5aba3d6",
      "0185_seed_price_baselines.sql": "0a39f818a718744e8900bb25c091aa9145908921b533d26649e1218f99428e3f",
    },
  },
  {
    relPath: "portava-stamp-wave1-files/artifacts/api-server/src/migrations",
    label: "Patch/zip extraction staging copy (stamp wave 1)",
    files: {
      "0176_moderation_reports.sql": "fb9bf6cd8615f04bdcd78a04350cbdcc5e00c4c01043e031c1ff17c1fe9bb71d",
      "0177_stamp_premium_foundation.sql": "1f6848315905292d3cc647c87194cea3d39f9056919bcd1be8dcb868e20152ff",
    },
  },
  {
    relPath: "portava-stamp-wave2-files/artifacts/api-server/src/migrations",
    label: "Patch/zip extraction staging copy (stamp wave 2)",
    files: {
      "0178_stamp_showcase_admire.sql": "dfe49f0fb2e16063a5ae39becc851f8f4831ecec86b8d8ab404f381a2f61a2f9",
    },
  },
  {
    relPath: "portava-stamp-wave3-files/artifacts/api-server/src/migrations",
    label: "Patch/zip extraction staging copy (stamp wave 3)",
    files: {
      "0179_stamp_criteria_engine.sql": "b4e273342f1f16bcd5315df209b1c04b40c56bf5b6035a97e36a05234dc32d40",
    },
  },
  {
    relPath: "portava-ai-header-generation/files/api-server/src/migrations",
    label: "Patch/zip extraction staging copy (AI header generation)",
    files: {
      "0189_generated_visuals.sql": "57da62dabde60ed10568a76ba302ea7c8d7e57df57fd93e8095e3508759361a6",
    },
  },
  {
    relPath: "stamps-backend/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0008_stamps.sql": "bbed909aec57818187d3f66f3f3e5ad8e0616d0d820b7c478efe5b5b52621dbc",
    },
  },
  {
    relPath: "posts-backend/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0003_posts.sql": "6c895950f43e2a652ec4f717945bef91ca71186ff7ed1ca0024b178038cd7316",
    },
  },
  {
    relPath: "passport-backend/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0004_passport.sql": "fb0a0eeb0e74899fba4559d7333de3c1d0b4085bc0988de18e39b2cda3c2c944",
    },
  },
  {
    relPath: "friends-backend/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0007_friends.sql": "3f09710994d81d496a7a11d27823af1107a5ead0cfbe0b1833816df1c1b461ec",
    },
  },
  {
    relPath: "follows-backend/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0006_follows.sql": "79860bcc4c04fcc505bee514cb5919bccf3f9ea8e9f57b26a0ec67620a680b96",
    },
  },
  {
    relPath: "composer-pkg/migrations",
    label: "Pre-consolidation per-domain prototype (one commit ever)",
    files: {
      "0005_storage_post_media.sql": "65306e186ae47a6215cbdbfb179a5e5d4df54a2f269ccaa1035c67f8e279bc54",
    },
  },
  // `_incoming` was frozen here on 2026-08-18 and removed again on 2026-08-23.
  // It was never in version control: `git log --all -- '_incoming'` returns
  // nothing, and it is the only entry in this list with zero files in the tree
  // (every other root has between 1 and 72 committed files). The four SHA-256
  // hashes were computed from an ops working directory that existed on one
  // machine, so on any fresh clone — every CI run — the root reads as "GONE
  // entirely" and the guard fails. It has been red since the day it landed.
  //
  // A guard cannot freeze what it cannot see. Pinning an uncommitted path does
  // not protect those files; it only guarantees a permanent red that trains
  // people to ignore this check, which is the opposite of what it is for.
  // If those scripts matter, commit them and re-freeze the committed copies.
];

/**
 * Individual .sql files that sit loose outside any dedicated migrations-shaped
 * directory (so freezing a whole directory doesn't apply), keyed by path
 * relative to the repo root.
 */
export const FROZEN_LOOSE_FILES: Record<string, string> = {
  "0160_beta_field_passthrough.sql": "822d87dbdf54c7bbec51ef745b566f7222ed52bceae3c76a8853e17998025a74",
  "0177_stamp_premium_foundation.sql": "1f6848315905292d3cc647c87194cea3d39f9056919bcd1be8dcb868e20152ff",
  "0178_stamp_showcase_admire.sql": "dfe49f0fb2e16063a5ae39becc851f8f4831ecec86b8d8ab404f381a2f61a2f9",
  "0179_stamp_criteria_engine.sql": "b4e273342f1f16bcd5315df209b1c04b40c56bf5b6035a97e36a05234dc32d40",
  "0180_activate_event_category_stamps.sql": "5d8157ff34b3ee636721f36691868e71372c301a9c0dbbf28a211fd79da8c063",
  "0181_stamp_unified_view.sql": "a1ef8cc7abe0f155488b4ec506afc52921937f00924c1f6adaded1a9f4d24d41",
  "0182_country_essentials.sql": "6e510436062f83cfdbd9416605b4895d76849b42c79fd28450115601ab0dde1d",
  "0183_budget_fx_conversion.sql": "6ae9a25ebfeea644f21caf490998ad221de18d89b22b3fff9be83afbb513b5ef",
  "0184_fsq_places.sql": "d47341e7ce50855a8c7aa4388a901393186adfed097f7a45d3d29fa0b5aba3d6",
  "0185_seed_price_baselines.sql": "0a39f818a718744e8900bb25c091aa9145908921b533d26649e1218f99428e3f",
  "CHECK-upsert_city_stamp-RPC.sql": "b3c2453ccb0e11c40044449b53c87bba19685221337440729b0216726f9aad0b",
  "portava-ai-header-generation/0189_generated_visuals.sql": "57da62dabde60ed10568a76ba302ea7c8d7e57df57fd93e8095e3508759361a6",
  "portava-ai-header-generation/flip-flags.sql": "50820d4ff7f36d9f86daa83f4c1f21ed767e898e420285babb0ca7394d6bb150",
};

