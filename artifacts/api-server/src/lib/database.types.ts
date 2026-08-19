export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_id: string | null
          category: string
          created_at: string
          event_type: string
          id: string
          metadata: Json
          source_id: string | null
          source_type: string | null
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          category: string
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          source_id?: string | null
          source_type?: string | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          category?: string
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          source_id?: string | null
          source_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "activity_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      admin_access_log: {
        Row: {
          action_taken: string
          admin_id: string
          id: string
          reason: string | null
          record_id: string
          record_type: string
          timestamp: string
        }
        Insert: {
          action_taken?: string
          admin_id: string
          id?: string
          reason?: string | null
          record_id: string
          record_type: string
          timestamp?: string
        }
        Update: {
          action_taken?: string
          admin_id?: string
          id?: string
          reason?: string | null
          record_id?: string
          record_type?: string
          timestamp?: string
        }
        Relationships: []
      }
      age_limit_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          metadata: Json | null
          new_max_age: number | null
          new_min_age: number | null
          old_max_age: number | null
          old_min_age: number | null
          reason: string | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          new_max_age?: number | null
          new_min_age?: number | null
          old_max_age?: number | null
          old_min_age?: number | null
          reason?: string | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          new_max_age?: number | null
          new_min_age?: number | null
          old_max_age?: number | null
          old_min_age?: number | null
          reason?: string | null
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "age_limit_audit_log_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "age_limit_audit_log_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      airport_profiles: {
        Row: {
          canonical_location_id: string | null
          checked_bags_extra_min: number
          city: string
          country: string
          country_code: string
          created_at: string
          created_by: string | null
          domestic_buffer_max: number
          domestic_buffer_min: number
          iata_code: string
          id: string
          immigration_extra_min: number
          international_buffer_max: number
          international_buffer_min: number
          lat: number
          lng: number
          name: string
          terminal_info: Json | null
          timezone: string
          traffic_extra_min: number
          updated_at: string
          verified: boolean
        }
        Insert: {
          canonical_location_id?: string | null
          checked_bags_extra_min?: number
          city: string
          country: string
          country_code: string
          created_at?: string
          created_by?: string | null
          domestic_buffer_max?: number
          domestic_buffer_min?: number
          iata_code: string
          id?: string
          immigration_extra_min?: number
          international_buffer_max?: number
          international_buffer_min?: number
          lat?: number
          lng?: number
          name: string
          terminal_info?: Json | null
          timezone?: string
          traffic_extra_min?: number
          updated_at?: string
          verified?: boolean
        }
        Update: {
          canonical_location_id?: string | null
          checked_bags_extra_min?: number
          city?: string
          country?: string
          country_code?: string
          created_at?: string
          created_by?: string | null
          domestic_buffer_max?: number
          domestic_buffer_min?: number
          iata_code?: string
          id?: string
          immigration_extra_min?: number
          international_buffer_max?: number
          international_buffer_min?: number
          lat?: number
          lng?: number
          name?: string
          terminal_info?: Json | null
          timezone?: string
          traffic_extra_min?: number
          updated_at?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "airport_profiles_canonical_location_id_fkey"
            columns: ["canonical_location_id"]
            isOneToOne: false
            referencedRelation: "canonical_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "airport_profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "airport_profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      appeals: {
        Row: {
          appellant_id: string
          created_at: string
          evidence_url: string | null
          id: string
          moderator_id: string | null
          reason: string
          resolution_note: string | null
          state: Database["public"]["Enums"]["appeal_state"]
          target_id: string
          target_type: Database["public"]["Enums"]["appeal_target_type"]
          updated_at: string
        }
        Insert: {
          appellant_id: string
          created_at?: string
          evidence_url?: string | null
          id?: string
          moderator_id?: string | null
          reason: string
          resolution_note?: string | null
          state?: Database["public"]["Enums"]["appeal_state"]
          target_id: string
          target_type: Database["public"]["Enums"]["appeal_target_type"]
          updated_at?: string
        }
        Update: {
          appellant_id?: string
          created_at?: string
          evidence_url?: string | null
          id?: string
          moderator_id?: string | null
          reason?: string
          resolution_note?: string | null
          state?: Database["public"]["Enums"]["appeal_state"]
          target_id?: string
          target_type?: Database["public"]["Enums"]["appeal_target_type"]
          updated_at?: string
        }
        Relationships: []
      }
      availability_nudges: {
        Row: {
          created_at: string
          id: string
          nudge_date: string
          recipient_id: string
          sender_id: string
          sent_on: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          nudge_date: string
          recipient_id: string
          sender_id: string
          sent_on?: string
          trip_id: string
        }
        Update: {
          created_at?: string
          id?: string
          nudge_date?: string
          recipient_id?: string
          sender_id?: string
          sent_on?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_nudges_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_nudges_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "availability_nudges_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_nudges_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "availability_nudges_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
          id: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
          id?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      buddy_availability_exceptions: {
        Row: {
          buddy_id: string
          created_at: string
          end_date: string | null
          end_time: string | null
          exception_date: string
          exception_type: Database["public"]["Enums"]["buddy_exception_type"]
          id: string
          reason: string | null
          start_time: string | null
          updated_at: string
        }
        Insert: {
          buddy_id: string
          created_at?: string
          end_date?: string | null
          end_time?: string | null
          exception_date: string
          exception_type?: Database["public"]["Enums"]["buddy_exception_type"]
          id?: string
          reason?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Update: {
          buddy_id?: string
          created_at?: string
          end_date?: string | null
          end_time?: string | null
          exception_date?: string
          exception_type?: Database["public"]["Enums"]["buddy_exception_type"]
          id?: string
          reason?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "buddy_availability_exceptions_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_availability_exceptions_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      buddy_booking_change_requests: {
        Row: {
          booking_id: string
          change_field: string
          created_at: string
          current_value: Json
          expires_at: string
          id: string
          proposed_value: Json
          reason: string | null
          requested_by: string
          responded_at: string | null
          responded_by: string | null
          response_note: string | null
          status: Database["public"]["Enums"]["rent_buddy_change_request_status"]
        }
        Insert: {
          booking_id: string
          change_field: string
          created_at?: string
          current_value?: Json
          expires_at?: string
          id?: string
          proposed_value?: Json
          reason?: string | null
          requested_by: string
          responded_at?: string | null
          responded_by?: string | null
          response_note?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_change_request_status"]
        }
        Update: {
          booking_id?: string
          change_field?: string
          created_at?: string
          current_value?: Json
          expires_at?: string
          id?: string
          proposed_value?: Json
          reason?: string | null
          requested_by?: string
          responded_at?: string | null
          responded_by?: string | null
          response_note?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_change_request_status"]
        }
        Relationships: [
          {
            foreignKeyName: "buddy_booking_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_change_requests_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_booking_events: {
        Row: {
          actor_user_id: string
          booking_id: string
          created_at: string
          event: string
          from_status: string | null
          id: string
          metadata: Json
          to_status: string | null
        }
        Insert: {
          actor_user_id: string
          booking_id: string
          created_at?: string
          event: string
          from_status?: string | null
          id?: string
          metadata?: Json
          to_status?: string | null
        }
        Update: {
          actor_user_id?: string
          booking_id?: string
          created_at?: string
          event?: string
          from_status?: string | null
          id?: string
          metadata?: Json
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "buddy_booking_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "buddy_booking_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_booking_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      buddy_services: {
        Row: {
          approved: boolean
          approved_at: string | null
          buddy_id: string
          category: string
          created_at: string
          description: string | null
          full_day_usd: number | null
          half_day_usd: number | null
          hourly_rate_usd: number | null
          id: string
          is_active: boolean
          max_group_size: number
          max_hours: number | null
          min_hours: number
          title: string
          updated_at: string
        }
        Insert: {
          approved?: boolean
          approved_at?: string | null
          buddy_id: string
          category: string
          created_at?: string
          description?: string | null
          full_day_usd?: number | null
          half_day_usd?: number | null
          hourly_rate_usd?: number | null
          id?: string
          is_active?: boolean
          max_group_size?: number
          max_hours?: number | null
          min_hours?: number
          title: string
          updated_at?: string
        }
        Update: {
          approved?: boolean
          approved_at?: string | null
          buddy_id?: string
          category?: string
          created_at?: string
          description?: string | null
          full_day_usd?: number | null
          half_day_usd?: number | null
          hourly_rate_usd?: number | null
          id?: string
          is_active?: boolean
          max_group_size?: number
          max_hours?: number | null
          min_hours?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "buddy_services_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buddy_services_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      call_moderation_actions: {
        Row: {
          action: string
          actor_id: string
          call_id: string
          created_at: string
          id: string
          target_id: string | null
        }
        Insert: {
          action: string
          actor_id: string
          call_id: string
          created_at?: string
          id?: string
          target_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string
          call_id?: string
          created_at?: string
          id?: string
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_moderation_actions_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_participants: {
        Row: {
          call_id: string
          hand_raised_at: string | null
          id: string
          invited_at: string | null
          joined_at: string | null
          left_at: string | null
          role: string
          status: string
          user_id: string
        }
        Insert: {
          call_id: string
          hand_raised_at?: string | null
          id?: string
          invited_at?: string | null
          joined_at?: string | null
          left_at?: string | null
          role: string
          status?: string
          user_id: string
        }
        Update: {
          call_id?: string
          hand_raised_at?: string | null
          id?: string
          invited_at?: string | null
          joined_at?: string | null
          left_at?: string | null
          role?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_participants_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_preferences: {
        Row: {
          allow_rent_a_buddy_calls: boolean
          allow_video_calls: boolean
          incoming_call_notifications: boolean
          updated_at: string
          user_id: string
          who_can_call: string
        }
        Insert: {
          allow_rent_a_buddy_calls?: boolean
          allow_video_calls?: boolean
          incoming_call_notifications?: boolean
          updated_at?: string
          user_id: string
          who_can_call?: string
        }
        Update: {
          allow_rent_a_buddy_calls?: boolean
          allow_video_calls?: boolean
          incoming_call_notifications?: boolean
          updated_at?: string
          user_id?: string
          who_can_call?: string
        }
        Relationships: []
      }
      call_sessions: {
        Row: {
          call_type: string
          connected_at: string | null
          context_id: string
          context_type: string
          created_at: string
          ended_at: string | null
          id: string
          room_name: string
          started_at: string
          started_by: string
          status: string
          thread_id: string | null
          updated_at: string
        }
        Insert: {
          call_type: string
          connected_at?: string | null
          context_id: string
          context_type: string
          created_at?: string
          ended_at?: string | null
          id?: string
          room_name: string
          started_at?: string
          started_by: string
          status?: string
          thread_id?: string | null
          updated_at?: string
        }
        Update: {
          call_type?: string
          connected_at?: string | null
          context_id?: string
          context_type?: string
          created_at?: string
          ended_at?: string | null
          id?: string
          room_name?: string
          started_at?: string
          started_by?: string
          status?: string
          thread_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      // hand-added; regenerate from live DB after apply (migration 2100_canonical_events.sql)
      canonical_events: {
        Row: {
          actor_id: string | null
          confidence: number | null
          created_at: string
          expires_at: string | null
          freshness_seconds: number | null
          id: string
          occurred_at: string
          payload: Json
          privacy_eligible: boolean | null
          source_count: number | null
          subject_id: string | null
          subject_kind: string | null
          verb: string
        }
        Insert: {
          actor_id?: string | null
          confidence?: number | null
          created_at?: string
          expires_at?: string | null
          freshness_seconds?: number | null
          id?: string
          occurred_at?: string
          payload?: Json
          privacy_eligible?: boolean | null
          source_count?: number | null
          subject_id?: string | null
          subject_kind?: string | null
          verb: string
        }
        Update: {
          actor_id?: string | null
          confidence?: number | null
          created_at?: string
          expires_at?: string | null
          freshness_seconds?: number | null
          id?: string
          occurred_at?: string
          payload?: Json
          privacy_eligible?: boolean | null
          source_count?: number | null
          subject_id?: string | null
          subject_kind?: string | null
          verb?: string
        }
        Relationships: []
      }
      canonical_locations: {
        Row: {
          aliases: string[]
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          display_name: string
          id: string
          kind: string
          lat: number | null
          lng: number | null
          name: string
          normalized_name: string
          postal_code: string | null
          provider_ids: Json
          region: string | null
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          display_name: string
          id?: string
          kind: string
          lat?: number | null
          lng?: number | null
          name: string
          normalized_name: string
          postal_code?: string | null
          provider_ids?: Json
          region?: string | null
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          display_name?: string
          id?: string
          kind?: string
          lat?: number | null
          lng?: number | null
          name?: string
          normalized_name?: string
          postal_code?: string | null
          provider_ids?: Json
          region?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      circle_age_settings: {
        Row: {
          age_limit_enabled: boolean
          max_age: number | null
          min_age: number | null
          owner_id: string
          updated_at: string
        }
        Insert: {
          age_limit_enabled?: boolean
          max_age?: number | null
          min_age?: number | null
          owner_id: string
          updated_at?: string
        }
        Update: {
          age_limit_enabled?: boolean
          max_age?: number | null
          min_age?: number | null
          owner_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "circle_age_settings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_age_settings_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_audit_events: {
        Row: {
          actor_user_id: string | null
          context_id: string | null
          context_type: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          target_user_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          context_id?: string | null
          context_type?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          target_user_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          context_id?: string | null
          context_type?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "circle_audit_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_audit_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "circle_audit_events_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_audit_events_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_checkins: {
        Row: {
          approximate_label: string | null
          checkin_type: string
          context_id: string
          context_type: string
          created_at: string
          id: string
          note: string | null
          user_id: string
          venue_label: string | null
        }
        Insert: {
          approximate_label?: string | null
          checkin_type: string
          context_id: string
          context_type: string
          created_at?: string
          id?: string
          note?: string | null
          user_id: string
          venue_label?: string | null
        }
        Update: {
          approximate_label?: string | null
          checkin_type?: string
          context_id?: string
          context_type?: string
          created_at?: string
          id?: string
          note?: string | null
          user_id?: string
          venue_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "circle_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_context_settings: {
        Row: {
          context_id: string
          context_type: string
          enabled: boolean
          id: string
          paused: boolean
          paused_until: string | null
          updated_at: string
          user_id: string
          visibility_mode_override: string | null
        }
        Insert: {
          context_id: string
          context_type: string
          enabled?: boolean
          id?: string
          paused?: boolean
          paused_until?: string | null
          updated_at?: string
          user_id: string
          visibility_mode_override?: string | null
        }
        Update: {
          context_id?: string
          context_type?: string
          enabled?: boolean
          id?: string
          paused?: boolean
          paused_until?: string | null
          updated_at?: string
          user_id?: string
          visibility_mode_override?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "circle_context_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_context_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_invites: {
        Row: {
          created_at: string
          id: string
          owner_id: string
          recipient_id: string
          responded_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          owner_id: string
          recipient_id: string
          responded_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          owner_id?: string
          recipient_id?: string
          responded_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      circle_meeting_points: {
        Row: {
          approximate_label: string | null
          context_id: string
          context_type: string
          created_at: string
          description: string | null
          host_user_id: string
          id: string
          is_active: boolean
          updated_at: string
          venue_label: string | null
        }
        Insert: {
          approximate_label?: string | null
          context_id: string
          context_type: string
          created_at?: string
          description?: string | null
          host_user_id: string
          id?: string
          is_active?: boolean
          updated_at?: string
          venue_label?: string | null
        }
        Update: {
          approximate_label?: string | null
          context_id?: string
          context_type?: string
          created_at?: string
          description?: string | null
          host_user_id?: string
          id?: string
          is_active?: boolean
          updated_at?: string
          venue_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "circle_meeting_points_host_user_id_fkey"
            columns: ["host_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_meeting_points_host_user_id_fkey"
            columns: ["host_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_member_visibility_overrides: {
        Row: {
          context_id: string
          context_type: string
          created_at: string
          direction: string
          hidden: boolean
          id: string
          target_user_id: string
          user_id: string
        }
        Insert: {
          context_id: string
          context_type: string
          created_at?: string
          direction: string
          hidden?: boolean
          id?: string
          target_user_id: string
          user_id: string
        }
        Update: {
          context_id?: string
          context_type?: string
          created_at?: string
          direction?: string
          hidden?: boolean
          id?: string
          target_user_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "circle_member_visibility_overrides_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_member_visibility_overrides_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "circle_member_visibility_overrides_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_member_visibility_overrides_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_memberships: {
        Row: {
          created_at: string
          other_id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          other_id: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          other_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "circle_memberships_other_id_fkey"
            columns: ["other_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_memberships_other_id_fkey"
            columns: ["other_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "circle_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_presence: {
        Row: {
          approximate_label: string | null
          checked_in: boolean
          context_id: string
          context_type: string
          created_at: string
          expires_at: string | null
          id: string
          is_stale: boolean
          last_seen_at: string
          needs_help: boolean
          stale_after_secs: number
          status: string
          status_label: string | null
          updated_at: string
          user_id: string
          venue_label: string | null
        }
        Insert: {
          approximate_label?: string | null
          checked_in?: boolean
          context_id: string
          context_type: string
          created_at?: string
          expires_at?: string | null
          id?: string
          is_stale?: boolean
          last_seen_at?: string
          needs_help?: boolean
          stale_after_secs?: number
          status?: string
          status_label?: string | null
          updated_at?: string
          user_id: string
          venue_label?: string | null
        }
        Update: {
          approximate_label?: string | null
          checked_in?: boolean
          context_id?: string
          context_type?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          is_stale?: boolean
          last_seen_at?: string
          needs_help?: boolean
          stale_after_secs?: number
          status?: string
          status_label?: string | null
          updated_at?: string
          user_id?: string
          venue_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "circle_presence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_presence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circle_visibility_settings: {
        Row: {
          consent_version: string | null
          consented_at: string | null
          event_sharing_default: string
          global_enabled: boolean
          is_paused: boolean
          paused_until: string | null
          trip_sharing_default: string
          updated_at: string
          user_id: string
          visibility_mode: string
        }
        Insert: {
          consent_version?: string | null
          consented_at?: string | null
          event_sharing_default?: string
          global_enabled?: boolean
          is_paused?: boolean
          paused_until?: string | null
          trip_sharing_default?: string
          updated_at?: string
          user_id: string
          visibility_mode?: string
        }
        Update: {
          consent_version?: string | null
          consented_at?: string | null
          event_sharing_default?: string
          global_enabled?: boolean
          is_paused?: boolean
          paused_until?: string | null
          trip_sharing_default?: string
          updated_at?: string
          user_id?: string
          visibility_mode?: string
        }
        Relationships: [
          {
            foreignKeyName: "circle_visibility_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circle_visibility_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      circles: {
        Row: {
          city: string | null
          cover_image_url: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          owner_id: string
          visibility: string
        }
        Insert: {
          city?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          owner_id: string
          visibility?: string
        }
        Update: {
          city?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          owner_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "circles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "circles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      city_country_geocode_cache: {
        Row: {
          city_key: string
          corrected_at: string | null
          country: string
          country_code: string
          deleted_at: string | null
          resolved_at: string
          updated_at: string
        }
        Insert: {
          city_key: string
          corrected_at?: string | null
          country: string
          country_code: string
          deleted_at?: string | null
          resolved_at?: string
          updated_at?: string
        }
        Update: {
          city_key?: string
          corrected_at?: string | null
          country?: string
          country_code?: string
          deleted_at?: string | null
          resolved_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      city_timezones: {
        Row: {
          city_key: string
          created_at: string
          timezone: string
          updated_at: string
        }
        Insert: {
          city_key: string
          created_at?: string
          timezone: string
          updated_at?: string
        }
        Update: {
          city_key?: string
          created_at?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      close_friends: {
        Row: {
          created_at: string
          friend_user_id: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          friend_user_id: string
          owner_id: string
        }
        Update: {
          created_at?: string
          friend_user_id?: string
          owner_id?: string
        }
        Relationships: []
      }
      collection_items: {
        Row: {
          collection_id: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["collection_entity_type"]
          id: string
          saved_at: string
        }
        Insert: {
          collection_id: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["collection_entity_type"]
          id?: string
          saved_at?: string
        }
        Update: {
          collection_id?: string
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["collection_entity_type"]
          id?: string
          saved_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_items_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
        ]
      }
      collections: {
        Row: {
          cover_url: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          owner_id: string
          position: number
          updated_at: string
        }
        Insert: {
          cover_url?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          owner_id: string
          position?: number
          updated_at?: string
        }
        Update: {
          cover_url?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          owner_id?: string
          position?: number
          updated_at?: string
        }
        Relationships: []
      }
      comment_likes: {
        Row: {
          comment_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_likes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "posts_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      compass_abuse_flags: {
        Row: {
          admin_notes: string | null
          detected_at: string
          evidence: Json
          id: string
          involved_users: string[]
          pattern_type: string
          reach_reduction_applied: boolean
          resolved_at: string | null
          reward_zeroed: boolean
          severity: string
          status: string
        }
        Insert: {
          admin_notes?: string | null
          detected_at?: string
          evidence?: Json
          id?: string
          involved_users?: string[]
          pattern_type: string
          reach_reduction_applied?: boolean
          resolved_at?: string | null
          reward_zeroed?: boolean
          severity?: string
          status?: string
        }
        Update: {
          admin_notes?: string | null
          detected_at?: string
          evidence?: Json
          id?: string
          involved_users?: string[]
          pattern_type?: string
          reach_reduction_applied?: boolean
          resolved_at?: string | null
          reward_zeroed?: boolean
          severity?: string
          status?: string
        }
        Relationships: []
      }
      compass_active_user_badges: {
        Row: {
          awarded_at: string | null
          badge_type: string
          created_at: string
          eligible: boolean
          expires_at: string | null
          id: string
          user_id: string
        }
        Insert: {
          awarded_at?: string | null
          badge_type: string
          created_at?: string
          eligible?: boolean
          expires_at?: string | null
          id?: string
          user_id: string
        }
        Update: {
          awarded_at?: string | null
          badge_type?: string
          created_at?: string
          eligible?: boolean
          expires_at?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_active_user_badges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_active_user_badges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_active_user_events: {
        Row: {
          category: string | null
          city: string | null
          created_at: string
          event_type: string
          id: string
          user_id: string
          weight: number
        }
        Insert: {
          category?: string | null
          city?: string | null
          created_at?: string
          event_type: string
          id?: string
          user_id: string
          weight?: number
        }
        Update: {
          category?: string | null
          city?: string | null
          created_at?: string
          event_type?: string
          id?: string
          user_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "compass_active_user_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_active_user_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_active_user_scores: {
        Row: {
          active_user_score: number
          boost_eligible: boolean
          boost_visibility_enabled: boolean
          created_at: string
          last_computed_at: string
          score_24h: number
          score_30d: number
          score_7d: number
          score_90d: number
          score_lifetime: number
          tier: string
          trust_multiplier: number
          user_id: string
        }
        Insert: {
          active_user_score?: number
          boost_eligible?: boolean
          boost_visibility_enabled?: boolean
          created_at?: string
          last_computed_at?: string
          score_24h?: number
          score_30d?: number
          score_7d?: number
          score_90d?: number
          score_lifetime?: number
          tier?: string
          trust_multiplier?: number
          user_id: string
        }
        Update: {
          active_user_score?: number
          boost_eligible?: boolean
          boost_visibility_enabled?: boolean
          created_at?: string
          last_computed_at?: string
          score_24h?: number
          score_30d?: number
          score_7d?: number
          score_90d?: number
          score_lifetime?: number
          tier?: string
          trust_multiplier?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_active_user_scores_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_active_user_scores_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_admin_actions: {
        Row: {
          action_type: string
          admin_id: string | null
          created_at: string
          id: string
          payload: Json | null
          target_id: string | null
        }
        Insert: {
          action_type: string
          admin_id?: string | null
          created_at?: string
          id?: string
          payload?: Json | null
          target_id?: string | null
        }
        Update: {
          action_type?: string
          admin_id?: string | null
          created_at?: string
          id?: string
          payload?: Json | null
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compass_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_admin_weight_sets: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
          weights: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
          weights?: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
          weights?: Json
        }
        Relationships: [
          {
            foreignKeyName: "compass_admin_weight_sets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_admin_weight_sets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_algorithm_versions: {
        Row: {
          id: string
          launched_at: string
          launched_by_admin_id: string | null
          notes: string | null
          retired_at: string | null
          rollback_available: boolean
          rollout_status: string
          version_tag: string
          weight_set_id: string | null
        }
        Insert: {
          id?: string
          launched_at?: string
          launched_by_admin_id?: string | null
          notes?: string | null
          retired_at?: string | null
          rollback_available?: boolean
          rollout_status?: string
          version_tag: string
          weight_set_id?: string | null
        }
        Update: {
          id?: string
          launched_at?: string
          launched_by_admin_id?: string | null
          notes?: string | null
          retired_at?: string | null
          rollback_available?: boolean
          rollout_status?: string
          version_tag?: string
          weight_set_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compass_algorithm_versions_launched_by_admin_id_fkey"
            columns: ["launched_by_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_algorithm_versions_launched_by_admin_id_fkey"
            columns: ["launched_by_admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "compass_algorithm_versions_weight_set_id_fkey"
            columns: ["weight_set_id"]
            isOneToOne: false
            referencedRelation: "compass_admin_weight_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      compass_analytics: {
        Row: {
          onboarding_completed: boolean
          onboarding_completed_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          onboarding_completed?: boolean
          onboarding_completed_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          onboarding_completed?: boolean
          onboarding_completed_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_analytics_events: {
        Row: {
          city: string | null
          compass_engine_version: string | null
          created_at: string
          event_name: string
          id: string
          item_id: string | null
          item_type: string | null
          metadata: Json
          section_name: string | null
          user_id: string
        }
        Insert: {
          city?: string | null
          compass_engine_version?: string | null
          created_at?: string
          event_name: string
          id?: string
          item_id?: string | null
          item_type?: string | null
          metadata?: Json
          section_name?: string | null
          user_id: string
        }
        Update: {
          city?: string | null
          compass_engine_version?: string | null
          created_at?: string
          event_name?: string
          id?: string
          item_id?: string | null
          item_type?: string | null
          metadata?: Json
          section_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      compass_cache_invalidations: {
        Row: {
          affected_keys: string[]
          id: string
          invalidated_at: string
          reason: string
          user_id: string
        }
        Insert: {
          affected_keys?: string[]
          id?: string
          invalidated_at?: string
          reason: string
          user_id: string
        }
        Update: {
          affected_keys?: string[]
          id?: string
          invalidated_at?: string
          reason?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_cache_invalidations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_cache_invalidations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_category_reputation: {
        Row: {
          category: string
          created_at: string
          id: string
          interaction_count: number
          last_active_at: string | null
          reputation_score: number
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          interaction_count?: number
          last_active_at?: string | null
          reputation_score?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          interaction_count?: number
          last_active_at?: string | null
          reputation_score?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_category_reputation_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_category_reputation_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_city_confidence: {
        Row: {
          city: string
          computed_at: string
          depth_score: number
          signals: Json
          tier: string
        }
        Insert: {
          city: string
          computed_at?: string
          depth_score?: number
          signals?: Json
          tier?: string
        }
        Update: {
          city?: string
          computed_at?: string
          depth_score?: number
          signals?: Json
          tier?: string
        }
        Relationships: []
      }
      compass_city_models: {
        Row: {
          built_at: string
          city: string
          monthly: Json
          sample_size: number
          time_slices: Json
          top_categories: Json
        }
        Insert: {
          built_at?: string
          city: string
          monthly?: Json
          sample_size?: number
          time_slices?: Json
          top_categories?: Json
        }
        Update: {
          built_at?: string
          city?: string
          monthly?: Json
          sample_size?: number
          time_slices?: Json
          top_categories?: Json
        }
        Relationships: []
      }
      compass_city_reputation: {
        Row: {
          city: string
          created_at: string
          id: string
          last_active_at: string | null
          reputation_score: number
          updated_at: string
          user_id: string
          visit_count: number
        }
        Insert: {
          city: string
          created_at?: string
          id?: string
          last_active_at?: string | null
          reputation_score?: number
          updated_at?: string
          user_id: string
          visit_count?: number
        }
        Update: {
          city?: string
          created_at?: string
          id?: string
          last_active_at?: string | null
          reputation_score?: number
          updated_at?: string
          user_id?: string
          visit_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "compass_city_reputation_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_city_reputation_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_content_freshness: {
        Row: {
          is_stale: boolean
          item_id: string
          item_type: string
          last_checked_at: string
          updated_at: string
        }
        Insert: {
          is_stale?: boolean
          item_id: string
          item_type: string
          last_checked_at?: string
          updated_at?: string
        }
        Update: {
          is_stale?: boolean
          item_id?: string
          item_type?: string
          last_checked_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      compass_conversation_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          payload: Json | null
          prompt_version: string | null
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          payload?: Json | null
          prompt_version?: string | null
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          payload?: Json | null
          prompt_version?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "compass_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      compass_conversations: {
        Row: {
          compressed_message_count: number
          created_at: string
          id: string
          last_active_at: string
          user_id: string
        }
        Insert: {
          compressed_message_count?: number
          created_at?: string
          id?: string
          last_active_at?: string
          user_id: string
        }
        Update: {
          compressed_message_count?: number
          created_at?: string
          id?: string
          last_active_at?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_eligibility_logs: {
        Row: {
          author_id: string | null
          created_at: string
          id: string
          item_id: string
          item_type: string
          rejection_reason: string
          viewer_id: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          id?: string
          item_id: string
          item_type: string
          rejection_reason: string
          viewer_id: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          id?: string
          item_id?: string
          item_type?: string
          rejection_reason?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_eligibility_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_eligibility_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_explanation_reasons: {
        Row: {
          explanation_key: string
          is_sensitive: boolean
          template: string
          updated_at: string
        }
        Insert: {
          explanation_key: string
          is_sensitive?: boolean
          template: string
          updated_at?: string
        }
        Update: {
          explanation_key?: string
          is_sensitive?: boolean
          template?: string
          updated_at?: string
        }
        Relationships: []
      }
      compass_feed_cache: {
        Row: {
          cache_key: string
          created_at: string
          entry_type: string
          expires_at: string
          id: string
          payload: Json
          user_id: string
        }
        Insert: {
          cache_key: string
          created_at?: string
          entry_type: string
          expires_at: string
          id?: string
          payload: Json
          user_id: string
        }
        Update: {
          cache_key?: string
          created_at?: string
          entry_type?: string
          expires_at?: string
          id?: string
          payload?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_feed_cache_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_feed_cache_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_feed_sections: {
        Row: {
          built_at: string
          cursor: string | null
          expires_at: string
          id: string
          item_ids: string[]
          section_name: string
          user_id: string
        }
        Insert: {
          built_at?: string
          cursor?: string | null
          expires_at?: string
          id?: string
          item_ids?: string[]
          section_name: string
          user_id: string
        }
        Update: {
          built_at?: string
          cursor?: string | null
          expires_at?: string
          id?: string
          item_ids?: string[]
          section_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_feed_sections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_feed_sections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_feedback: {
        Row: {
          action: string
          created_at: string
          id: string
          item_id: string
          item_type: string
          metadata: Json | null
          recommendation_id: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          item_id: string
          item_type: string
          metadata?: Json | null
          recommendation_id?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          item_id?: string
          item_type?: string
          metadata?: Json | null
          recommendation_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      compass_feedback_events: {
        Row: {
          action: string
          created_at: string
          id: string
          item_id: string
          item_type: string
          metadata: Json
          recommendation_id: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          item_id: string
          item_type: string
          metadata?: Json
          recommendation_id: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          item_id?: string
          item_type?: string
          metadata?: Json
          recommendation_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_feedback_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_feedback_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_frontload_rules: {
        Row: {
          conditions: Json
          enabled: boolean
          id: string
          rule_name: string
          tier: number
          updated_at: string
        }
        Insert: {
          conditions?: Json
          enabled?: boolean
          id?: string
          rule_name: string
          tier: number
          updated_at?: string
        }
        Update: {
          conditions?: Json
          enabled?: boolean
          id?: string
          rule_name?: string
          tier?: number
          updated_at?: string
        }
        Relationships: []
      }
      compass_graph_edges: {
        Row: {
          attrs: Json
          dst_key: string
          dst_type: string
          edge_type: string
          first_seen: string | null
          id: string
          last_seen: string | null
          observed_count: number
          src_key: string
          src_type: string
          updated_at: string
          weight: number
        }
        Insert: {
          attrs?: Json
          dst_key: string
          dst_type: string
          edge_type: string
          first_seen?: string | null
          id?: string
          last_seen?: string | null
          observed_count?: number
          src_key: string
          src_type: string
          updated_at?: string
          weight?: number
        }
        Update: {
          attrs?: Json
          dst_key?: string
          dst_type?: string
          edge_type?: string
          first_seen?: string | null
          id?: string
          last_seen?: string | null
          observed_count?: number
          src_key?: string
          src_type?: string
          updated_at?: string
          weight?: number
        }
        Relationships: []
      }
      compass_graph_nodes: {
        Row: {
          attrs: Json
          city: string | null
          created_at: string
          id: string
          node_key: string
          node_type: string
          updated_at: string
        }
        Insert: {
          attrs?: Json
          city?: string | null
          created_at?: string
          id?: string
          node_key: string
          node_type: string
          updated_at?: string
        }
        Update: {
          attrs?: Json
          city?: string | null
          created_at?: string
          id?: string
          node_key?: string
          node_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      compass_intent_modes: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          enabled: boolean
          icon: string | null
          min_trust_level: string | null
          mode: string
          night_only: boolean
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          enabled?: boolean
          icon?: string | null
          min_trust_level?: string | null
          mode: string
          night_only?: boolean
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          enabled?: boolean
          icon?: string | null
          min_trust_level?: string | null
          mode?: string
          night_only?: boolean
        }
        Relationships: []
      }
      compass_live_sessions: {
        Row: {
          checks_run: number
          context: Json
          ended_at: string | null
          id: string
          last_check_at: string | null
          nudges_delivered: number
          started_at: string
          status: string
          summary: Json | null
          trip_id: string | null
          user_id: string
        }
        Insert: {
          checks_run?: number
          context?: Json
          ended_at?: string | null
          id?: string
          last_check_at?: string | null
          nudges_delivered?: number
          started_at?: string
          status?: string
          summary?: Json | null
          trip_id?: string | null
          user_id: string
        }
        Update: {
          checks_run?: number
          context?: Json
          ended_at?: string | null
          id?: string
          last_check_at?: string | null
          nudges_delivered?: number
          started_at?: string
          status?: string
          summary?: Json | null
          trip_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      compass_media_preload_manifest: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          media_type: string
          priority: number
          tier: number
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          media_type: string
          priority?: number
          tier: number
          url: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          media_type?: string
          priority?: number
          tier?: number
          url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_media_preload_manifest_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_media_preload_manifest_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_memories: {
        Row: {
          category: string
          circle_owner_id: string | null
          confidence: number
          content: string
          conversation_id: string | null
          created_at: string
          id: string
          scope: string
          source: string
          trip_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          circle_owner_id?: string | null
          confidence?: number
          content: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          scope: string
          source?: string
          trip_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          circle_owner_id?: string | null
          confidence?: number
          content?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          scope?: string
          source?: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_notification_decisions: {
        Row: {
          created_at: string
          id: string
          notification_type: string
          outcome: string
          payload_hash: string | null
          priority_level: number
          suppression_reason: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notification_type: string
          outcome: string
          payload_hash?: string | null
          priority_level: number
          suppression_reason?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notification_type?: string
          outcome?: string
          payload_hash?: string | null
          priority_level?: number
          suppression_reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_notification_decisions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_notification_decisions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_outcome_events: {
        Row: {
          id: string
          item_id: string
          item_type: string
          occurred_at: string
          predicted_match: number | null
          recommendation_id: string
          source: string | null
          stage: string
          stage_value: number
          user_id: string
        }
        Insert: {
          id?: string
          item_id: string
          item_type: string
          occurred_at?: string
          predicted_match?: number | null
          recommendation_id: string
          source?: string | null
          stage: string
          stage_value?: number
          user_id: string
        }
        Update: {
          id?: string
          item_id?: string
          item_type?: string
          occurred_at?: string
          predicted_match?: number | null
          recommendation_id?: string
          source?: string | null
          stage?: string
          stage_value?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_outcome_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_outcome_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_preload_events: {
        Row: {
          created_at: string
          id: string
          occurred_at: string
          screen_name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          occurred_at: string
          screen_name: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          occurred_at?: string
          screen_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_preload_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_preload_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_preload_queue: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          item_id: string
          priority: number
          scheduled_at: string
          tier: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          item_id: string
          priority?: number
          scheduled_at?: string
          tier: number
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          item_id?: string
          priority?: number
          scheduled_at?: string
          tier?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_preload_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_preload_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_privacy_guard_logs: {
        Row: {
          created_at: string
          id: string
          item_id: string
          item_type: string
          scrubbed_fields: string[]
          viewer_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          item_type: string
          scrubbed_fields?: string[]
          viewer_id: string
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          item_type?: string
          scrubbed_fields?: string[]
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_privacy_guard_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_privacy_guard_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_recent_context: {
        Row: {
          city: string | null
          client_hints: Json | null
          context_state: string
          country: string | null
          created_at: string
          expires_at: string
          id: string
          intent_mode: string
          signals: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          city?: string | null
          client_hints?: Json | null
          context_state?: string
          country?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent_mode?: string
          signals?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          city?: string | null
          client_hints?: Json | null
          context_state?: string
          country?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent_mode?: string
          signals?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_recommendation_scores: {
        Row: {
          context_state: string | null
          created_at: string
          final_score: number
          id: string
          item_id: string
          item_type: string
          score_components: Json
          viewer_id: string
        }
        Insert: {
          context_state?: string | null
          created_at?: string
          final_score: number
          id?: string
          item_id: string
          item_type: string
          score_components?: Json
          viewer_id: string
        }
        Update: {
          context_state?: string | null
          created_at?: string
          final_score?: number
          id?: string
          item_id?: string
          item_type?: string
          score_components?: Json
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_recommendation_scores_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_recommendation_scores_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_rollbacks: {
        Row: {
          created_at: string
          from_version_id: string | null
          id: string
          reason: string | null
          rolled_back_by: string | null
          to_version_id: string | null
        }
        Insert: {
          created_at?: string
          from_version_id?: string | null
          id?: string
          reason?: string | null
          rolled_back_by?: string | null
          to_version_id?: string | null
        }
        Update: {
          created_at?: string
          from_version_id?: string | null
          id?: string
          reason?: string | null
          rolled_back_by?: string | null
          to_version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compass_rollbacks_from_version_id_fkey"
            columns: ["from_version_id"]
            isOneToOne: false
            referencedRelation: "compass_algorithm_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_rollbacks_rolled_back_by_fkey"
            columns: ["rolled_back_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_rollbacks_rolled_back_by_fkey"
            columns: ["rolled_back_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "compass_rollbacks_to_version_id_fkey"
            columns: ["to_version_id"]
            isOneToOne: false
            referencedRelation: "compass_algorithm_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      compass_safety_filter_logs: {
        Row: {
          author_id: string | null
          block_reason: string
          created_at: string
          id: string
          item_id: string
          item_type: string
          viewer_id: string
        }
        Insert: {
          author_id?: string | null
          block_reason: string
          created_at?: string
          id?: string
          item_id: string
          item_type: string
          viewer_id: string
        }
        Update: {
          author_id?: string | null
          block_reason?: string
          created_at?: string
          id?: string
          item_id?: string
          item_type?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_safety_filter_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_safety_filter_logs_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_sense_nudges: {
        Row: {
          action_url: string | null
          body: string
          category: string
          confidence: Json | null
          created_at: string
          dedupe_key: string
          id: string
          nudge_type: string
          title: string
          user_id: string
        }
        Insert: {
          action_url?: string | null
          body: string
          category: string
          confidence?: Json | null
          created_at?: string
          dedupe_key: string
          id?: string
          nudge_type: string
          title: string
          user_id: string
        }
        Update: {
          action_url?: string | null
          body?: string
          category?: string
          confidence?: Json | null
          created_at?: string
          dedupe_key?: string
          id?: string
          nudge_type?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_sense_settings: {
        Row: {
          categories: Json
          presence_level: string
          updated_at: string
          user_id: string
        }
        Insert: {
          categories?: Json
          presence_level?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          categories?: Json
          presence_level?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      compass_served_recommendations: {
        Row: {
          created_at: string
          explanation_key: string
          explanation_looked_up_at: string | null
          id: string
          item_id: string
          item_type: string
          ranking_factors: Json | null
          recommendation_id: string
          section_name: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          explanation_key: string
          explanation_looked_up_at?: string | null
          id?: string
          item_id: string
          item_type: string
          ranking_factors?: Json | null
          recommendation_id: string
          section_name?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          explanation_key?: string
          explanation_looked_up_at?: string | null
          id?: string
          item_id?: string
          item_type?: string
          ranking_factors?: Json | null
          recommendation_id?: string
          section_name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_served_recommendations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_served_recommendations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_settings: {
        Row: {
          allow_smart_notifications: boolean
          created_at: string
          onboarding_completed: boolean
          onboarding_completed_at: string | null
          show_buddy_recommendations: boolean
          show_people_recommendations: boolean
          updated_at: string
          use_chosen_city: boolean
          use_history: boolean
          use_location: boolean
          use_saved_items: boolean
          use_trip_data: boolean
          user_id: string
        }
        Insert: {
          allow_smart_notifications?: boolean
          created_at?: string
          onboarding_completed?: boolean
          onboarding_completed_at?: string | null
          show_buddy_recommendations?: boolean
          show_people_recommendations?: boolean
          updated_at?: string
          use_chosen_city?: boolean
          use_history?: boolean
          use_location?: boolean
          use_saved_items?: boolean
          use_trip_data?: boolean
          user_id: string
        }
        Update: {
          allow_smart_notifications?: boolean
          created_at?: string
          onboarding_completed?: boolean
          onboarding_completed_at?: string | null
          show_buddy_recommendations?: boolean
          show_people_recommendations?: boolean
          updated_at?: string
          use_chosen_city?: boolean
          use_history?: boolean
          use_location?: boolean
          use_saved_items?: boolean
          use_trip_data?: boolean
          user_id?: string
        }
        Relationships: []
      }
      compass_suspension_requests: {
        Row: {
          created_at: string
          id: string
          reason: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason: string
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          reason?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_suspension_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_suspension_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_testing_scenarios: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          last_result: Json | null
          name: string
          scenario: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_result?: Json | null
          name: string
          scenario?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          last_result?: Json | null
          name?: string
          scenario?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_testing_scenarios_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_testing_scenarios_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_user_context_snapshots: {
        Row: {
          computed_at: string
          context_state: string
          id: string
          intent_mode: string
          secondary_modes: string[]
          signals: Json
          user_id: string
        }
        Insert: {
          computed_at?: string
          context_state: string
          id?: string
          intent_mode: string
          secondary_modes?: string[]
          signals?: Json
          user_id: string
        }
        Update: {
          computed_at?: string
          context_state?: string
          id?: string
          intent_mode?: string
          secondary_modes?: string[]
          signals?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_user_context_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_user_context_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_user_navigation_patterns: {
        Row: {
          from_screen: string
          last_seen_at: string
          to_screen: string
          transition_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          from_screen: string
          last_seen_at?: string
          to_screen: string
          transition_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          from_screen?: string
          last_seen_at?: string
          to_screen?: string
          transition_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_user_navigation_patterns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_user_navigation_patterns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_user_preferences: {
        Row: {
          boost_visibility_enabled: boolean
          budget_filter: string | null
          category_weights: Json
          compass_enabled: boolean
          delayed_post_default: boolean
          exclude_budget_styles: string[]
          hidden_categories: string[]
          ignored_item_ids: string[]
          intent_mode_override: string | null
          interests: string[] | null
          location_privacy_mode: string
          min_trust_level: string | null
          muted_hashtags: string[]
          muted_topics: string[]
          notification_preferences: Json
          preferred_languages: string[]
          public_meetups_only: boolean
          rent_buddy_discoverable: boolean
          safety_preference: string
          show_explanations: boolean
          travel_styles: string[]
          updated_at: string
          user_id: string
          visibility_sub_controls: Json
        }
        Insert: {
          boost_visibility_enabled?: boolean
          budget_filter?: string | null
          category_weights?: Json
          compass_enabled?: boolean
          delayed_post_default?: boolean
          exclude_budget_styles?: string[]
          hidden_categories?: string[]
          ignored_item_ids?: string[]
          intent_mode_override?: string | null
          interests?: string[] | null
          location_privacy_mode?: string
          min_trust_level?: string | null
          muted_hashtags?: string[]
          muted_topics?: string[]
          notification_preferences?: Json
          preferred_languages?: string[]
          public_meetups_only?: boolean
          rent_buddy_discoverable?: boolean
          safety_preference?: string
          show_explanations?: boolean
          travel_styles?: string[]
          updated_at?: string
          user_id: string
          visibility_sub_controls?: Json
        }
        Update: {
          boost_visibility_enabled?: boolean
          budget_filter?: string | null
          category_weights?: Json
          compass_enabled?: boolean
          delayed_post_default?: boolean
          exclude_budget_styles?: string[]
          hidden_categories?: string[]
          ignored_item_ids?: string[]
          intent_mode_override?: string | null
          interests?: string[] | null
          location_privacy_mode?: string
          min_trust_level?: string | null
          muted_hashtags?: string[]
          muted_topics?: string[]
          notification_preferences?: Json
          preferred_languages?: string[]
          public_meetups_only?: boolean
          rent_buddy_discoverable?: boolean
          safety_preference?: string
          show_explanations?: boolean
          travel_styles?: string[]
          updated_at?: string
          user_id?: string
          visibility_sub_controls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "compass_user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_user_profiles: {
        Row: {
          active_user_score: number | null
          block_count: number
          blocker_count: number
          budget_style: string | null
          computed_at: string
          current_city: string | null
          current_country: string | null
          has_active_booking: boolean
          has_active_trip: boolean
          preferred_cities: string[]
          preferred_languages: string[]
          safe_return_active: boolean
          safety_preference: string
          social_style: string | null
          travel_styles: string[]
          trust_level: string | null
          trust_score: number | null
          upcoming_trip_within_48h: boolean
          updated_at: string
          user_id: string
          visibility_preference: string
        }
        Insert: {
          active_user_score?: number | null
          block_count?: number
          blocker_count?: number
          budget_style?: string | null
          computed_at?: string
          current_city?: string | null
          current_country?: string | null
          has_active_booking?: boolean
          has_active_trip?: boolean
          preferred_cities?: string[]
          preferred_languages?: string[]
          safe_return_active?: boolean
          safety_preference?: string
          social_style?: string | null
          travel_styles?: string[]
          trust_level?: string | null
          trust_score?: number | null
          upcoming_trip_within_48h?: boolean
          updated_at?: string
          user_id: string
          visibility_preference?: string
        }
        Update: {
          active_user_score?: number | null
          block_count?: number
          blocker_count?: number
          budget_style?: string | null
          computed_at?: string
          current_city?: string | null
          current_country?: string | null
          has_active_booking?: boolean
          has_active_trip?: boolean
          preferred_cities?: string[]
          preferred_languages?: string[]
          safe_return_active?: boolean
          safety_preference?: string
          social_style?: string | null
          travel_styles?: string[]
          trust_level?: string | null
          trust_score?: number | null
          upcoming_trip_within_48h?: boolean
          updated_at?: string
          user_id?: string
          visibility_preference?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_user_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_user_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_visibility_boosts: {
        Row: {
          appearance_count: number
          author_id: string
          boost_type: string
          cap: number
          cap_hit_at: string | null
          first_seen_at: string
          id: string
          item_id: string
          item_type: string
          last_seen_at: string
          report_ended_at: string | null
        }
        Insert: {
          appearance_count?: number
          author_id: string
          boost_type?: string
          cap?: number
          cap_hit_at?: string | null
          first_seen_at?: string
          id?: string
          item_id: string
          item_type: string
          last_seen_at?: string
          report_ended_at?: string | null
        }
        Update: {
          appearance_count?: number
          author_id?: string
          boost_type?: string
          cap?: number
          cap_hit_at?: string | null
          first_seen_at?: string
          id?: string
          item_id?: string
          item_type?: string
          last_seen_at?: string
          report_ended_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compass_visibility_boosts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_visibility_boosts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      compass_visibility_cooldowns: {
        Row: {
          author_id: string
          cooldown_type: string
          ends_at: string
          id: string
          reason: string | null
          started_at: string
        }
        Insert: {
          author_id: string
          cooldown_type?: string
          ends_at: string
          id?: string
          reason?: string | null
          started_at?: string
        }
        Update: {
          author_id?: string
          cooldown_type?: string
          ends_at?: string
          id?: string
          reason?: string | null
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compass_visibility_cooldowns_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compass_visibility_cooldowns_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      content_distribution_stats: {
        Row: {
          comments: number
          content_id: string
          content_type: string
          created_at: string
          creator_id: string | null
          dwell_time_ms: number
          eligible_impressions: number
          evaluation_complete: boolean
          first_evaluated_at: string | null
          item_id: string | null
          last_impression_at: string | null
          last_updated_at: string
          negative_actions: number
          negative_signal_count: number
          opens: number
          positive_actions: number
          saves: number
          shares: number
          underexposure_status: Database["public"]["Enums"]["underexposure_status_enum"]
          unique_viewers: number
          updated_at: string
        }
        Insert: {
          comments?: number
          content_id?: string
          content_type?: string
          created_at?: string
          creator_id?: string | null
          dwell_time_ms?: number
          eligible_impressions?: number
          evaluation_complete?: boolean
          first_evaluated_at?: string | null
          item_id?: string | null
          last_impression_at?: string | null
          last_updated_at?: string
          negative_actions?: number
          negative_signal_count?: number
          opens?: number
          positive_actions?: number
          saves?: number
          shares?: number
          underexposure_status?: Database["public"]["Enums"]["underexposure_status_enum"]
          unique_viewers?: number
          updated_at?: string
        }
        Update: {
          comments?: number
          content_id?: string
          content_type?: string
          created_at?: string
          creator_id?: string | null
          dwell_time_ms?: number
          eligible_impressions?: number
          evaluation_complete?: boolean
          first_evaluated_at?: string | null
          item_id?: string | null
          last_impression_at?: string | null
          last_updated_at?: string
          negative_actions?: number
          negative_signal_count?: number
          opens?: number
          positive_actions?: number
          saves?: number
          shares?: number
          underexposure_status?: Database["public"]["Enums"]["underexposure_status_enum"]
          unique_viewers?: number
          updated_at?: string
        }
        Relationships: []
      }
      content_stamps: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          migrated_from: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          migrated_from?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          migrated_from?: string | null
          user_id?: string
        }
        Relationships: []
      }
      content_translations: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          error_message: string | null
          id: string
          provider: string | null
          source_language: string
          status: string
          target_language: string
          translated_fields: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          error_message?: string | null
          id?: string
          provider?: string | null
          source_language: string
          status?: string
          target_language: string
          translated_fields?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          error_message?: string | null
          id?: string
          provider?: string | null
          source_language?: string
          status?: string
          target_language?: string
          translated_fields?: Json
          updated_at?: string
        }
        Relationships: []
      }
      country_essentials: {
        Row: {
          code: string
          confidence: string
          drive_side: string | null
          emergency: Json
          frequency: number | null
          last_verified_at: string
          plug_types: string[]
          source: string
          updated_at: string
          voltage: number | null
        }
        Insert: {
          code: string
          confidence?: string
          drive_side?: string | null
          emergency?: Json
          frequency?: number | null
          last_verified_at?: string
          plug_types?: string[]
          source?: string
          updated_at?: string
          voltage?: number | null
        }
        Update: {
          code?: string
          confidence?: string
          drive_side?: string | null
          emergency?: Json
          frequency?: number | null
          last_verified_at?: string
          plug_types?: string[]
          source?: string
          updated_at?: string
          voltage?: number | null
        }
        Relationships: []
      }
      country_metadata: {
        Row: {
          calling_codes: Json
          capital: string | null
          code: string
          currencies: Json
          fetched_at: string
          flag_emoji: string | null
          languages: Json
          name: string
          official_name: string | null
          region: string | null
          source: string
        }
        Insert: {
          calling_codes?: Json
          capital?: string | null
          code: string
          currencies?: Json
          fetched_at?: string
          flag_emoji?: string | null
          languages?: Json
          name: string
          official_name?: string | null
          region?: string | null
          source: string
        }
        Update: {
          calling_codes?: Json
          capital?: string | null
          code?: string
          currencies?: Json
          fetched_at?: string
          flag_emoji?: string | null
          languages?: Json
          name?: string
          official_name?: string | null
          region?: string | null
          source?: string
        }
        Relationships: []
      }
      creator_activity_scores: {
        Row: {
          calculated_at: string
          calculation_version: string
          community_participation_score: number
          consistency_score: number
          created_at: string
          maintenance_score: number
          positive_response_score: number
          recent_contribution_score: number
          repetition_penalty: number
          safety_multiplier: number
          score: number
          spam_penalty: number
          updated_at: string
          user_id: string
        }
        Insert: {
          calculated_at?: string
          calculation_version?: string
          community_participation_score?: number
          consistency_score?: number
          created_at?: string
          maintenance_score?: number
          positive_response_score?: number
          recent_contribution_score?: number
          repetition_penalty?: number
          safety_multiplier?: number
          score?: number
          spam_penalty?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          calculated_at?: string
          calculation_version?: string
          community_participation_score?: number
          consistency_score?: number
          created_at?: string
          maintenance_score?: number
          positive_response_score?: number
          recent_contribution_score?: number
          repetition_penalty?: number
          safety_multiplier?: number
          score?: number
          spam_penalty?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      daily_briefs: {
        Row: {
          brief_date: string
          brief_json: string
          brief_type: string
          generated_at: string
          id: string
          trip_id: string
          user_id: string
        }
        Insert: {
          brief_date: string
          brief_json: string
          brief_type?: string
          generated_at?: string
          id?: string
          trip_id: string
          user_id: string
        }
        Update: {
          brief_date?: string
          brief_json?: string
          brief_type?: string
          generated_at?: string
          id?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_briefs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      delayed_post_location_events: {
        Row: {
          created_at: string
          event_type: Database["public"]["Enums"]["delayed_post_event_type"]
          id: string
          lat: number | null
          lng: number | null
          metadata: Json | null
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: Database["public"]["Enums"]["delayed_post_event_type"]
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: Database["public"]["Enums"]["delayed_post_event_type"]
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delayed_post_location_events_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      destination_identities: {
        Row: {
          city: string | null
          country: string
          country_code: string
          created_at: string
          id: string
          identity_key: string
          motif: string
          palette: Json
          status: string
          updated_at: string
          wide_focus: number
        }
        Insert: {
          city?: string | null
          country: string
          country_code: string
          created_at?: string
          id?: string
          identity_key: string
          motif?: string
          palette: Json
          status?: string
          updated_at?: string
          wide_focus?: number
        }
        Update: {
          city?: string | null
          country?: string
          country_code?: string
          created_at?: string
          id?: string
          identity_key?: string
          motif?: string
          palette?: Json
          status?: string
          updated_at?: string
          wide_focus?: number
        }
        Relationships: []
      }
      devices: {
        Row: {
          created_at: string
          device_fingerprint: string | null
          id: string
          key_package_count: number
          last_seen_at: string
          platform: string
          public_key: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          device_fingerprint?: string | null
          id?: string
          key_package_count?: number
          last_seen_at?: string
          platform: string
          public_key?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          device_fingerprint?: string | null
          id?: string
          key_package_count?: number
          last_seen_at?: string
          platform?: string
          public_key?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      discovery_cache: {
        Row: {
          cache_key: string
          cached_at: string
          category: string
          destination: string
          expires_at: string
          geocode_display: string | null
          geocode_lat: number | null
          geocode_lng: number | null
          places: Json
          radius_km: number
        }
        Insert: {
          cache_key: string
          cached_at?: string
          category: string
          destination: string
          expires_at: string
          geocode_display?: string | null
          geocode_lat?: number | null
          geocode_lng?: number | null
          places?: Json
          radius_km: number
        }
        Update: {
          cache_key?: string
          cached_at?: string
          category?: string
          destination?: string
          expires_at?: string
          geocode_display?: string | null
          geocode_lat?: number | null
          geocode_lng?: number | null
          places?: Json
          radius_km?: number
        }
        Relationships: []
      }
      discovery_geocode_cache: {
        Row: {
          cached_at: string
          display_name: string
          expires_at: string
          lat: number
          lng: number
          location_key: string
        }
        Insert: {
          cached_at?: string
          display_name: string
          expires_at: string
          lat: number
          lng: number
          location_key: string
        }
        Update: {
          cached_at?: string
          display_name?: string
          expires_at?: string
          lat?: number
          lng?: number
          location_key?: string
        }
        Relationships: []
      }
      discovery_place_reports: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          place_id: string
          reason: string
          reporter_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          place_id: string
          reason: string
          reporter_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          place_id?: string
          reason?: string
          reporter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discovery_place_reports_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "discovery_places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_place_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_place_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      discovery_place_saves: {
        Row: {
          place_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          place_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          place_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discovery_place_saves_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "discovery_places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_place_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_place_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      discovery_places: {
        Row: {
          blurb: string | null
          canonical_location_id: string | null
          category: string | null
          city: string
          created_at: string
          header_image_attribution: string | null
          header_image_generated_id: string | null
          header_image_source: string | null
          header_image_status: string
          header_image_updated_at: string | null
          header_image_url: string | null
          id: string
          image_accuracy_status: string
          image_source_type: string | null
          image_url: string | null
          lat: number | null
          lng: number | null
          max_age: number | null
          min_age: number | null
          name: string
          neighborhood: string | null
          note: string | null
          osm_id: string | null
          photos: string[] | null
          place_type: string
          primary_category: string
          rating: number | null
          saved_count: number
          secondary_categories: string[]
          source: string | null
          status: string
          submitted_by: string | null
          tag: string | null
          verified: boolean
        }
        Insert: {
          blurb?: string | null
          canonical_location_id?: string | null
          category?: string | null
          city?: string
          created_at?: string
          header_image_attribution?: string | null
          header_image_generated_id?: string | null
          header_image_source?: string | null
          header_image_status?: string
          header_image_updated_at?: string | null
          header_image_url?: string | null
          id?: string
          image_accuracy_status?: string
          image_source_type?: string | null
          image_url?: string | null
          lat?: number | null
          lng?: number | null
          max_age?: number | null
          min_age?: number | null
          name: string
          neighborhood?: string | null
          note?: string | null
          osm_id?: string | null
          photos?: string[] | null
          place_type: string
          primary_category?: string
          rating?: number | null
          saved_count?: number
          secondary_categories?: string[]
          source?: string | null
          status?: string
          submitted_by?: string | null
          tag?: string | null
          verified?: boolean
        }
        Update: {
          blurb?: string | null
          canonical_location_id?: string | null
          category?: string | null
          city?: string
          created_at?: string
          header_image_attribution?: string | null
          header_image_generated_id?: string | null
          header_image_source?: string | null
          header_image_status?: string
          header_image_updated_at?: string | null
          header_image_url?: string | null
          id?: string
          image_accuracy_status?: string
          image_source_type?: string | null
          image_url?: string | null
          lat?: number | null
          lng?: number | null
          max_age?: number | null
          min_age?: number | null
          name?: string
          neighborhood?: string | null
          note?: string | null
          osm_id?: string | null
          photos?: string[] | null
          place_type?: string
          primary_category?: string
          rating?: number | null
          saved_count?: number
          secondary_categories?: string[]
          source?: string | null
          status?: string
          submitted_by?: string | null
          tag?: string | null
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "discovery_places_canonical_location_id_fkey"
            columns: ["canonical_location_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_places_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_places_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      entry_requirements: {
        Row: {
          allowed_stay_days: number | null
          confidence: string
          created_at: string
          destination_country: string
          fee_text: string | null
          id: string
          last_verified_at: string
          notes: string | null
          official_source_url: string
          passport_country: string
          passport_validity_rule: string | null
          processing_time_text: string | null
          status: string
          updated_at: string
          verified_by: string | null
        }
        Insert: {
          allowed_stay_days?: number | null
          confidence?: string
          created_at?: string
          destination_country: string
          fee_text?: string | null
          id?: string
          last_verified_at?: string
          notes?: string | null
          official_source_url: string
          passport_country: string
          passport_validity_rule?: string | null
          processing_time_text?: string | null
          status: string
          updated_at?: string
          verified_by?: string | null
        }
        Update: {
          allowed_stay_days?: number | null
          confidence?: string
          created_at?: string
          destination_country?: string
          fee_text?: string | null
          id?: string
          last_verified_at?: string
          notes?: string | null
          official_source_url?: string
          passport_country?: string
          passport_validity_rule?: string | null
          processing_time_text?: string | null
          status?: string
          updated_at?: string
          verified_by?: string | null
        }
        Relationships: []
      }
      event_activity_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          event_id: string
          id: string
          metadata: Json
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          event_id: string
          id?: string
          metadata?: Json
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          event_id?: string
          id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "event_activity_log_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_agenda_items: {
        Row: {
          added_by: string | null
          created_at: string
          event_id: string
          id: string
          location_lat: number | null
          location_lng: number | null
          location_name: string | null
          place_id: string | null
          title: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          event_id: string
          id?: string
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          place_id?: string | null
          title: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          event_id?: string
          id?: string
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          place_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_agenda_items_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_attendee_states: {
        Row: {
          checked_in_at: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          event_id: string
          no_show_at: string | null
          no_show_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          checked_in_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          event_id: string
          no_show_at?: string | null
          no_show_by?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          checked_in_at?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          event_id?: string
          no_show_at?: string | null
          no_show_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_attendee_states_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attendee_states_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "event_attendee_states_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attendee_states_no_show_by_fkey"
            columns: ["no_show_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attendee_states_no_show_by_fkey"
            columns: ["no_show_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "event_attendee_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_attendee_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      event_attendees: {
        Row: {
          added_at: string
          event_id: string
          user_id: string
        }
        Insert: {
          added_at?: string
          event_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          event_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_attendees_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_cohosts: {
        Row: {
          added_at: string
          added_by: string
          event_id: string
          id: string
          permissions: Json
          user_id: string
        }
        Insert: {
          added_at?: string
          added_by: string
          event_id: string
          id?: string
          permissions?: Json
          user_id: string
        }
        Update: {
          added_at?: string
          added_by?: string
          event_id?: string
          id?: string
          permissions?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_cohosts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_drafts: {
        Row: {
          created_at: string
          data: Json
          host_id: string
          id: string
          last_saved_at: string
        }
        Insert: {
          created_at?: string
          data?: Json
          host_id: string
          id?: string
          last_saved_at?: string
        }
        Update: {
          created_at?: string
          data?: Json
          host_id?: string
          id?: string
          last_saved_at?: string
        }
        Relationships: []
      }
      event_invites: {
        Row: {
          created_at: string
          event_id: string
          id: string
          invitee_id: string
          inviter_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          invitee_id: string
          inviter_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          invitee_id?: string
          inviter_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_invites_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_join_requests: {
        Row: {
          created_at: string
          event_id: string
          id: string
          message: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          message?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          message?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_join_requests_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_join_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_join_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "event_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      event_media: {
        Row: {
          caption: string | null
          created_at: string
          event_id: string
          id: string
          media_type: string
          media_url: string
          uploader_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          event_id: string
          id?: string
          media_type?: string
          media_url: string
          uploader_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          event_id?: string
          id?: string
          media_type?: string
          media_url?: string
          uploader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_media_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_posts: {
        Row: {
          author_id: string
          body: string
          created_at: string
          event_id: string
          id: string
          media_urls: string[]
          pinned: boolean
          updated_at: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          event_id: string
          id?: string
          media_urls?: string[]
          pinned?: boolean
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          event_id?: string
          id?: string
          media_urls?: string[]
          pinned?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_posts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_reminders: {
        Row: {
          created_at: string
          event_id: string
          id: string
          note: string | null
          remind_at: string
          sent: boolean
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          note?: string | null
          remind_at: string
          sent?: boolean
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          note?: string | null
          remind_at?: string
          sent?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_reminders_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_reports: {
        Row: {
          created_at: string
          event_id: string
          id: string
          notes: string | null
          reason: string
          report_type: string
          reporter_id: string
          status: string
          target_user_id: string | null
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          notes?: string | null
          reason: string
          report_type?: string
          reporter_id: string
          status?: string
          target_user_id?: string | null
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          notes?: string | null
          reason?: string
          report_type?: string
          reporter_id?: string
          status?: string
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_reports_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_reviews: {
        Row: {
          anonymous: boolean
          body: string | null
          created_at: string
          event_id: string
          id: string
          rating: number
          reviewer_id: string
          updated_at: string
        }
        Insert: {
          anonymous?: boolean
          body?: string | null
          created_at?: string
          event_id: string
          id?: string
          rating: number
          reviewer_id: string
          updated_at?: string
        }
        Update: {
          anonymous?: boolean
          body?: string | null
          created_at?: string
          event_id?: string
          id?: string
          rating?: number
          reviewer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_reviews_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      event_roles: {
        Row: {
          created_at: string
          event_id: string
          role: Database["public"]["Enums"]["event_role_type"]
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          role: Database["public"]["Enums"]["event_role_type"]
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          role?: Database["public"]["Enums"]["event_role_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_roles_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      event_rsvps: {
        Row: {
          created_at: string
          event_id: string
          status: Database["public"]["Enums"]["event_rsvp_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          status: Database["public"]["Enums"]["event_rsvp_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          status?: Database["public"]["Enums"]["event_rsvp_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_rsvps_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_rsvps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_rsvps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      event_saves: {
        Row: {
          event_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          event_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          event_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_saves_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_share_links: {
        Row: {
          created_at: string
          creator_id: string
          event_id: string
          expires_at: string | null
          id: string
          max_uses: number | null
          token: string
          use_count: number
        }
        Insert: {
          created_at?: string
          creator_id: string
          event_id: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          token?: string
          use_count?: number
        }
        Update: {
          created_at?: string
          creator_id?: string
          event_id?: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          token?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_share_links_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_updates: {
        Row: {
          author_id: string
          body: string
          created_at: string
          event_id: string
          id: string
          pinned: boolean
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          event_id: string
          id?: string
          pinned?: boolean
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          event_id?: string
          id?: string
          pinned?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "event_updates_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_updates_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "event_updates_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_waitlist: {
        Row: {
          created_at: string
          event_id: string
          offer_expires_at: string | null
          position: number
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          offer_expires_at?: string | null
          position: number
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          offer_expires_at?: string | null
          position?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_waitlist_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_waitlist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_waitlist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      events: {
        Row: {
          age_max: number | null
          age_min: number | null
          attendee_comments_enabled: boolean
          avg_rating: number | null
          category: string | null
          chat_enabled: boolean
          chat_thread_id: string | null
          circle_id: string | null
          city: string | null
          country: string | null
          cover_image_height: number | null
          cover_image_width: number | null
          cover_media_type: string | null
          cover_source: string | null
          cover_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          featured: boolean
          geog: unknown
          going_count: number
          header_image_attribution: string | null
          header_image_generated_id: string | null
          header_image_source: string | null
          header_image_status: string
          header_image_updated_at: string | null
          host_id: string
          id: string
          is_recurring: boolean
          location_lat: number | null
          location_lng: number | null
          location_name: string | null
          max_attendees: number | null
          original_language: string | null
          price_type: string | null
          price_url: string | null
          recurring_config: Json | null
          review_count: number
          rsvp_closed: boolean
          rsvp_options: string[]
          safety_notes: string | null
          show_exact_location: boolean
          show_header_publicly: boolean
          starts_at: string | null
          state: Database["public"]["Enums"]["event_state"]
          tags: string[]
          ticket_url: string | null
          title: string
          trip_id: string | null
          trust_score_min: number | null
          updated_at: string
          verified_only: boolean
          visibility: Database["public"]["Enums"]["event_visibility"]
          waitlist_count: number
          waitlist_enabled: boolean
        }
        Insert: {
          age_max?: number | null
          age_min?: number | null
          attendee_comments_enabled?: boolean
          avg_rating?: number | null
          category?: string | null
          chat_enabled?: boolean
          chat_thread_id?: string | null
          circle_id?: string | null
          city?: string | null
          country?: string | null
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_media_type?: string | null
          cover_source?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          featured?: boolean
          geog?: unknown
          going_count?: number
          header_image_attribution?: string | null
          header_image_generated_id?: string | null
          header_image_source?: string | null
          header_image_status?: string
          header_image_updated_at?: string | null
          host_id: string
          id?: string
          is_recurring?: boolean
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          max_attendees?: number | null
          original_language?: string | null
          price_type?: string | null
          price_url?: string | null
          recurring_config?: Json | null
          review_count?: number
          rsvp_closed?: boolean
          rsvp_options?: string[]
          safety_notes?: string | null
          show_exact_location?: boolean
          show_header_publicly?: boolean
          starts_at?: string | null
          state?: Database["public"]["Enums"]["event_state"]
          tags?: string[]
          ticket_url?: string | null
          title: string
          trip_id?: string | null
          trust_score_min?: number | null
          updated_at?: string
          verified_only?: boolean
          visibility?: Database["public"]["Enums"]["event_visibility"]
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Update: {
          age_max?: number | null
          age_min?: number | null
          attendee_comments_enabled?: boolean
          avg_rating?: number | null
          category?: string | null
          chat_enabled?: boolean
          chat_thread_id?: string | null
          circle_id?: string | null
          city?: string | null
          country?: string | null
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_media_type?: string | null
          cover_source?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          featured?: boolean
          geog?: unknown
          going_count?: number
          header_image_attribution?: string | null
          header_image_generated_id?: string | null
          header_image_source?: string | null
          header_image_status?: string
          header_image_updated_at?: string | null
          host_id?: string
          id?: string
          is_recurring?: boolean
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          max_attendees?: number | null
          original_language?: string | null
          price_type?: string | null
          price_url?: string | null
          recurring_config?: Json | null
          review_count?: number
          rsvp_closed?: boolean
          rsvp_options?: string[]
          safety_notes?: string | null
          show_exact_location?: boolean
          show_header_publicly?: boolean
          starts_at?: string | null
          state?: Database["public"]["Enums"]["event_state"]
          tags?: string[]
          ticket_url?: string | null
          title?: string
          trip_id?: string | null
          trust_score_min?: number | null
          updated_at?: string
          verified_only?: boolean
          visibility?: Database["public"]["Enums"]["event_visibility"]
          waitlist_count?: number
          waitlist_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "events_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      external_place_references: {
        Row: {
          attribution: string | null
          confidence: string
          created_at: string
          id: string
          last_fetched_at: string | null
          last_verified_at: string | null
          license_metadata: Json
          place_id: string
          provider: string
          provider_place_id: string
          provider_url: string | null
          raw_category: string | null
        }
        Insert: {
          attribution?: string | null
          confidence?: string
          created_at?: string
          id?: string
          last_fetched_at?: string | null
          last_verified_at?: string | null
          license_metadata?: Json
          place_id: string
          provider: string
          provider_place_id: string
          provider_url?: string | null
          raw_category?: string | null
        }
        Update: {
          attribution?: string | null
          confidence?: string
          created_at?: string
          id?: string
          last_fetched_at?: string | null
          last_verified_at?: string | null
          license_metadata?: Json
          place_id?: string
          provider?: string
          provider_place_id?: string
          provider_url?: string | null
          raw_category?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "external_place_references_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flag_audit_log: {
        Row: {
          changed_at: string
          changed_by_user_id: string | null
          flag: string
          id: number
          new_enabled: boolean
          old_enabled: boolean
        }
        Insert: {
          changed_at?: string
          changed_by_user_id?: string | null
          flag: string
          id?: number
          new_enabled: boolean
          old_enabled: boolean
        }
        Update: {
          changed_at?: string
          changed_by_user_id?: string | null
          flag?: string
          id?: number
          new_enabled?: boolean
          old_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "feature_flag_audit_log_flag_fkey"
            columns: ["flag"]
            isOneToOne: false
            referencedRelation: "feature_flags"
            referencedColumns: ["flag"]
          },
        ]
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean
          flag: string
          metadata: Json | null
          updated_at: string
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          flag: string
          metadata?: Json | null
          updated_at?: string
        }
        Update: {
          description?: string | null
          enabled?: boolean
          flag?: string
          metadata?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      friend_requests: {
        Row: {
          created_at: string | null
          id: string
          recipient_id: string
          requester_id: string
          responded_at: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          recipient_id: string
          requester_id: string
          responded_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          recipient_id?: string
          requester_id?: string
          responded_at?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      // hand-added; regenerate from live DB after apply (migration 2102_freshness_policies.sql)
      freshness_policies: {
        Row: {
          claim_type: string
          note: string | null
          ttl_seconds: number
          updated_at: string
        }
        Insert: {
          claim_type: string
          note?: string | null
          ttl_seconds: number
          updated_at?: string
        }
        Update: {
          claim_type?: string
          note?: string | null
          ttl_seconds?: number
          updated_at?: string
        }
        Relationships: []
      }
      fsq_city_ingests: {
        Row: {
          bbox: Json | null
          city_key: string
          dataset_date: string
          ingested_at: string
          place_count: number
        }
        Insert: {
          bbox?: Json | null
          city_key: string
          dataset_date: string
          ingested_at?: string
          place_count?: number
        }
        Update: {
          bbox?: Json | null
          city_key?: string
          dataset_date?: string
          ingested_at?: string
          place_count?: number
        }
        Relationships: []
      }
      fsq_places: {
        Row: {
          address: string | null
          category: string
          city_key: string
          confidence: string
          country: string | null
          dataset_date: string
          fsq_category_ids: string[]
          fsq_category_labels: string[]
          fsq_id: string
          fsq_primary_label: string | null
          geog: unknown
          ingested_at: string
          latitude: number
          locality: string | null
          longitude: number
          name: string
          postcode: string | null
          region: string | null
          source: string
        }
        Insert: {
          address?: string | null
          category?: string
          city_key: string
          confidence?: string
          country?: string | null
          dataset_date: string
          fsq_category_ids?: string[]
          fsq_category_labels?: string[]
          fsq_id: string
          fsq_primary_label?: string | null
          geog?: unknown
          ingested_at?: string
          latitude: number
          locality?: string | null
          longitude: number
          name: string
          postcode?: string | null
          region?: string | null
          source?: string
        }
        Update: {
          address?: string | null
          category?: string
          city_key?: string
          confidence?: string
          country?: string | null
          dataset_date?: string
          fsq_category_ids?: string[]
          fsq_category_labels?: string[]
          fsq_id?: string
          fsq_primary_label?: string | null
          geog?: unknown
          ingested_at?: string
          latitude?: number
          locality?: string | null
          longitude?: number
          name?: string
          postcode?: string | null
          region?: string | null
          source?: string
        }
        Relationships: []
      }
      fx_rates: {
        Row: {
          base_currency: string
          currency: string
          fetched_at: string
          id: string
          rate: number
          rate_date: string
          source: string
        }
        Insert: {
          base_currency: string
          currency: string
          fetched_at?: string
          id?: string
          rate: number
          rate_date: string
          source: string
        }
        Update: {
          base_currency?: string
          currency?: string
          fetched_at?: string
          id?: string
          rate?: number
          rate_date?: string
          source?: string
        }
        Relationships: []
      }
      generated_visuals: {
        Row: {
          accepted_at: string | null
          accuracy_status: string
          aspect_ratio: string
          attempt_count: number
          canonical_place_id: string | null
          card_path: string | null
          created_at: string
          disclaimer_required: boolean
          disclaimer_text: string | null
          entity_id: string
          entity_type: string
          failure_code: string | null
          failure_message: string | null
          final_prompt: string | null
          generated_at: string | null
          generated_with_ai: boolean
          generation_cost_estimate: number | null
          generation_method: string | null
          hero_path: string | null
          id: string
          image_source_type: string | null
          input_snapshot: Json
          last_accuracy_reviewed_at: string | null
          locked_by: string | null
          locked_until: string | null
          model: string | null
          moderation_details: Json | null
          moderation_status: string | null
          negative_prompt: string | null
          owner_user_id: string | null
          prompt_hash: string
          prompt_version: string
          provider: string
          provider_place_id: string | null
          purpose: string
          reference_asset_ids: Json | null
          reference_image_count: number | null
          replaced_at: string | null
          retry_after: string | null
          share_path: string | null
          source_attribution: string | null
          source_image_url: string | null
          source_license: string | null
          source_provider: string | null
          source_url: string | null
          status: string
          storage_path: string | null
          style: string
          thumbnail_path: string | null
          updated_at: string
          verification_status: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          accepted_at?: string | null
          accuracy_status?: string
          aspect_ratio?: string
          attempt_count?: number
          canonical_place_id?: string | null
          card_path?: string | null
          created_at?: string
          disclaimer_required?: boolean
          disclaimer_text?: string | null
          entity_id: string
          entity_type: string
          failure_code?: string | null
          failure_message?: string | null
          final_prompt?: string | null
          generated_at?: string | null
          generated_with_ai?: boolean
          generation_cost_estimate?: number | null
          generation_method?: string | null
          hero_path?: string | null
          id?: string
          image_source_type?: string | null
          input_snapshot?: Json
          last_accuracy_reviewed_at?: string | null
          locked_by?: string | null
          locked_until?: string | null
          model?: string | null
          moderation_details?: Json | null
          moderation_status?: string | null
          negative_prompt?: string | null
          owner_user_id?: string | null
          prompt_hash: string
          prompt_version: string
          provider: string
          provider_place_id?: string | null
          purpose: string
          reference_asset_ids?: Json | null
          reference_image_count?: number | null
          replaced_at?: string | null
          retry_after?: string | null
          share_path?: string | null
          source_attribution?: string | null
          source_image_url?: string | null
          source_license?: string | null
          source_provider?: string | null
          source_url?: string | null
          status?: string
          storage_path?: string | null
          style?: string
          thumbnail_path?: string | null
          updated_at?: string
          verification_status?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          accepted_at?: string | null
          accuracy_status?: string
          aspect_ratio?: string
          attempt_count?: number
          canonical_place_id?: string | null
          card_path?: string | null
          created_at?: string
          disclaimer_required?: boolean
          disclaimer_text?: string | null
          entity_id?: string
          entity_type?: string
          failure_code?: string | null
          failure_message?: string | null
          final_prompt?: string | null
          generated_at?: string | null
          generated_with_ai?: boolean
          generation_cost_estimate?: number | null
          generation_method?: string | null
          hero_path?: string | null
          id?: string
          image_source_type?: string | null
          input_snapshot?: Json
          last_accuracy_reviewed_at?: string | null
          locked_by?: string | null
          locked_until?: string | null
          model?: string | null
          moderation_details?: Json | null
          moderation_status?: string | null
          negative_prompt?: string | null
          owner_user_id?: string | null
          prompt_hash?: string
          prompt_version?: string
          provider?: string
          provider_place_id?: string | null
          purpose?: string
          reference_asset_ids?: Json | null
          reference_image_count?: number | null
          replaced_at?: string | null
          retry_after?: string | null
          share_path?: string | null
          source_attribution?: string | null
          source_image_url?: string | null
          source_license?: string | null
          source_provider?: string | null
          source_url?: string | null
          status?: string
          storage_path?: string | null
          style?: string
          thumbnail_path?: string | null
          updated_at?: string
          verification_status?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generated_visuals_canonical_place_id_fkey"
            columns: ["canonical_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      geo_zones: {
        Row: {
          bounds_json: Json | null
          center_lat: number | null
          center_lng: number | null
          city: string | null
          country_code: string | null
          created_at: string
          created_by: string | null
          featured: boolean
          id: string
          is_system: boolean
          metadata: Json | null
          name: string
          polygon_geojson: Json | null
          radius_meters: number | null
          safety_rating: string | null
          updated_at: string
          verified: boolean
          zone_type: string
        }
        Insert: {
          bounds_json?: Json | null
          center_lat?: number | null
          center_lng?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          featured?: boolean
          id?: string
          is_system?: boolean
          metadata?: Json | null
          name: string
          polygon_geojson?: Json | null
          radius_meters?: number | null
          safety_rating?: string | null
          updated_at?: string
          verified?: boolean
          zone_type: string
        }
        Update: {
          bounds_json?: Json | null
          center_lat?: number | null
          center_lng?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          featured?: boolean
          id?: string
          is_system?: boolean
          metadata?: Json | null
          name?: string
          polygon_geojson?: Json | null
          radius_meters?: number | null
          safety_rating?: string | null
          updated_at?: string
          verified?: boolean
          zone_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "geo_zones_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geo_zones_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      geofence_admin_settings: {
        Row: {
          default_radius_m: number
          default_radius_meters: number
          id: number
          max_radius_m: number
          max_radius_meters: number
          min_radius_m: number
          min_radius_meters: number
          no_show_affects_reliability: boolean
          updated_at: string
        }
        Insert: {
          default_radius_m?: number
          default_radius_meters?: number
          id?: number
          max_radius_m?: number
          max_radius_meters?: number
          min_radius_m?: number
          min_radius_meters?: number
          no_show_affects_reliability?: boolean
          updated_at?: string
        }
        Update: {
          default_radius_m?: number
          default_radius_meters?: number
          id?: number
          max_radius_m?: number
          max_radius_meters?: number
          min_radius_m?: number
          min_radius_meters?: number
          no_show_affects_reliability?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      hashtag_reports: {
        Row: {
          created_at: string
          hashtag_id: string
          id: string
          reason: string
          reporter_id: string
        }
        Insert: {
          created_at?: string
          hashtag_id: string
          id?: string
          reason: string
          reporter_id: string
        }
        Update: {
          created_at?: string
          hashtag_id?: string
          id?: string
          reason?: string
          reporter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hashtag_reports_hashtag_id_fkey"
            columns: ["hashtag_id"]
            isOneToOne: false
            referencedRelation: "hashtags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hashtag_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hashtag_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      hashtag_usage: {
        Row: {
          author_id: string
          city: string | null
          country: string | null
          created_at: string
          hashtag_id: string
          id: string
          source_id: string
          source_type: string
        }
        Insert: {
          author_id: string
          city?: string | null
          country?: string | null
          created_at?: string
          hashtag_id: string
          id?: string
          source_id: string
          source_type: string
        }
        Update: {
          author_id?: string
          city?: string | null
          country?: string | null
          created_at?: string
          hashtag_id?: string
          id?: string
          source_id?: string
          source_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "hashtag_usage_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hashtag_usage_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "hashtag_usage_hashtag_id_fkey"
            columns: ["hashtag_id"]
            isOneToOne: false
            referencedRelation: "hashtags"
            referencedColumns: ["id"]
          },
        ]
      }
      hashtags: {
        Row: {
          blocked_at: string | null
          blocked_reason: string | null
          created_at: string
          id: string
          is_blocked: boolean
          is_hidden_from_trending: boolean
          name: string
          slug: string
          updated_at: string
          usage_count: number
        }
        Insert: {
          blocked_at?: string | null
          blocked_reason?: string | null
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_hidden_from_trending?: boolean
          name: string
          slug: string
          updated_at?: string
          usage_count?: number
        }
        Update: {
          blocked_at?: string | null
          blocked_reason?: string | null
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_hidden_from_trending?: boolean
          name?: string
          slug?: string
          updated_at?: string
          usage_count?: number
        }
        Relationships: []
      }
      hidden_gem_reports: {
        Row: {
          created_at: string
          gem_id: string
          id: string
          notes: string | null
          reason: string
          reporter_id: string
          status: string
        }
        Insert: {
          created_at?: string
          gem_id: string
          id?: string
          notes?: string | null
          reason: string
          reporter_id: string
          status?: string
        }
        Update: {
          created_at?: string
          gem_id?: string
          id?: string
          notes?: string | null
          reason?: string
          reporter_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "hidden_gem_reports_gem_id_fkey"
            columns: ["gem_id"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      hidden_gem_saves: {
        Row: {
          gem_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          gem_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          gem_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hidden_gem_saves_gem_id_fkey"
            columns: ["gem_id"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      hidden_gem_verifications: {
        Row: {
          created_at: string
          distance_m: number | null
          gem_id: string
          id: string
          method: string
          notes: string | null
          result: string
          user_id: string
        }
        Insert: {
          created_at?: string
          distance_m?: number | null
          gem_id: string
          id?: string
          method: string
          notes?: string | null
          result: string
          user_id: string
        }
        Update: {
          created_at?: string
          distance_m?: number | null
          gem_id?: string
          id?: string
          method?: string
          notes?: string | null
          result?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hidden_gem_verifications_gem_id_fkey"
            columns: ["gem_id"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_verifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_verifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      hidden_gem_visits: {
        Row: {
          distance_m: number | null
          gem_id: string
          id: string
          is_suspicious: boolean
          latitude: number | null
          longitude: number | null
          trust_level: string
          user_id: string
          visited_at: string
        }
        Insert: {
          distance_m?: number | null
          gem_id: string
          id?: string
          is_suspicious?: boolean
          latitude?: number | null
          longitude?: number | null
          trust_level?: string
          user_id: string
          visited_at?: string
        }
        Update: {
          distance_m?: number | null
          gem_id?: string
          id?: string
          is_suspicious?: boolean
          latitude?: number | null
          longitude?: number | null
          trust_level?: string
          user_id?: string
          visited_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "hidden_gem_visits_gem_id_fkey"
            columns: ["gem_id"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_visits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gem_visits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      hidden_gems: {
        Row: {
          accessibility: string | null
          approx_geog: unknown
          approx_latitude: number | null
          approx_longitude: number | null
          best_time_to_go: string | null
          canonical_place_id: string | null
          category: string
          city: string
          country: string | null
          created_at: string
          crowd_level: string | null
          description: string | null
          geog: unknown
          guide_verified_by: string | null
          id: string
          image_url: string | null
          latitude: number | null
          layover_safe: boolean | null
          local_etiquette: string | null
          longitude: number | null
          merged_into: string | null
          minimum_layover_minutes: number | null
          moderation_status: string | null
          name: string
          neighborhood: string | null
          price_range: string | null
          report_count: number
          safety_notes: string | null
          save_count: number
          sensitivity_level: Database["public"]["Enums"]["hidden_gem_sensitivity"]
          source_confirmation: string | null
          source_type: string | null
          status: Database["public"]["Enums"]["hidden_gem_status"]
          submitted_by: string | null
          updated_at: string
          verification_level: Database["public"]["Enums"]["hidden_gem_verification_level"]
          vibe_tags: string[] | null
          visibility: string
          visit_count: number
        }
        Insert: {
          accessibility?: string | null
          approx_geog?: unknown
          approx_latitude?: number | null
          approx_longitude?: number | null
          best_time_to_go?: string | null
          canonical_place_id?: string | null
          category: string
          city: string
          country?: string | null
          created_at?: string
          crowd_level?: string | null
          description?: string | null
          geog?: unknown
          guide_verified_by?: string | null
          id?: string
          image_url?: string | null
          latitude?: number | null
          layover_safe?: boolean | null
          local_etiquette?: string | null
          longitude?: number | null
          merged_into?: string | null
          minimum_layover_minutes?: number | null
          moderation_status?: string | null
          name: string
          neighborhood?: string | null
          price_range?: string | null
          report_count?: number
          safety_notes?: string | null
          save_count?: number
          sensitivity_level?: Database["public"]["Enums"]["hidden_gem_sensitivity"]
          source_confirmation?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["hidden_gem_status"]
          submitted_by?: string | null
          updated_at?: string
          verification_level?: Database["public"]["Enums"]["hidden_gem_verification_level"]
          vibe_tags?: string[] | null
          visibility?: string
          visit_count?: number
        }
        Update: {
          accessibility?: string | null
          approx_geog?: unknown
          approx_latitude?: number | null
          approx_longitude?: number | null
          best_time_to_go?: string | null
          canonical_place_id?: string | null
          category?: string
          city?: string
          country?: string | null
          created_at?: string
          crowd_level?: string | null
          description?: string | null
          geog?: unknown
          guide_verified_by?: string | null
          id?: string
          image_url?: string | null
          latitude?: number | null
          layover_safe?: boolean | null
          local_etiquette?: string | null
          longitude?: number | null
          merged_into?: string | null
          minimum_layover_minutes?: number | null
          moderation_status?: string | null
          name?: string
          neighborhood?: string | null
          price_range?: string | null
          report_count?: number
          safety_notes?: string | null
          save_count?: number
          sensitivity_level?: Database["public"]["Enums"]["hidden_gem_sensitivity"]
          source_confirmation?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["hidden_gem_status"]
          submitted_by?: string | null
          updated_at?: string
          verification_level?: Database["public"]["Enums"]["hidden_gem_verification_level"]
          vibe_tags?: string[] | null
          visibility?: string
          visit_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "hidden_gems_guide_verified_by_fkey"
            columns: ["guide_verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gems_guide_verified_by_fkey"
            columns: ["guide_verified_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "hidden_gems_merged_into_fkey"
            columns: ["merged_into"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gems_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hidden_gems_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      highlight_likes: {
        Row: {
          created_at: string
          highlight_id: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          highlight_id: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          highlight_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlight_likes_highlight_id_fkey"
            columns: ["highlight_id"]
            isOneToOne: false
            referencedRelation: "highlights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      highlight_replies: {
        Row: {
          created_at: string
          highlight_id: string
          id: string
          replier_id: string
          thread_id: string | null
        }
        Insert: {
          created_at?: string
          highlight_id: string
          id?: string
          replier_id: string
          thread_id?: string | null
        }
        Update: {
          created_at?: string
          highlight_id?: string
          id?: string
          replier_id?: string
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "highlight_replies_highlight_id_fkey"
            columns: ["highlight_id"]
            isOneToOne: false
            referencedRelation: "highlights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_replies_replier_id_fkey"
            columns: ["replier_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_replies_replier_id_fkey"
            columns: ["replier_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      highlight_reports: {
        Row: {
          created_at: string
          highlight_id: string
          id: string
          reason: string
          reporter_id: string
        }
        Insert: {
          created_at?: string
          highlight_id: string
          id?: string
          reason?: string
          reporter_id: string
        }
        Update: {
          created_at?: string
          highlight_id?: string
          id?: string
          reason?: string
          reporter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlight_reports_highlight_id_fkey"
            columns: ["highlight_id"]
            isOneToOne: false
            referencedRelation: "highlights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      highlight_views: {
        Row: {
          highlight_id: string
          id: string
          viewed_at: string
          viewer_id: string
        }
        Insert: {
          highlight_id: string
          id?: string
          viewed_at?: string
          viewer_id: string
        }
        Update: {
          highlight_id?: string
          id?: string
          viewed_at?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlight_views_highlight_id_fkey"
            columns: ["highlight_id"]
            isOneToOne: false
            referencedRelation: "highlights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_views_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlight_views_viewer_id_fkey"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      highlights: {
        Row: {
          archived_at: string | null
          caption: string | null
          created_at: string
          deleted_at: string | null
          expires_at: string
          filter_id: string
          filter_intensity: number
          id: string
          location_city: string | null
          location_country: string | null
          location_name: string | null
          media_type: string
          media_url: string
          owner_id: string
          updated_at: string
          video_duration_seconds: number | null
          visibility: string
        }
        Insert: {
          archived_at?: string | null
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          expires_at: string
          filter_id?: string
          filter_intensity?: number
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          media_type: string
          media_url: string
          owner_id: string
          updated_at?: string
          video_duration_seconds?: number | null
          visibility?: string
        }
        Update: {
          archived_at?: string | null
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          expires_at?: string
          filter_id?: string
          filter_intensity?: number
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          media_type?: string
          media_url?: string
          owner_id?: string
          updated_at?: string
          video_duration_seconds?: number | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "highlights_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "highlights_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      identity_verifications: {
        Row: {
          created_at: string
          document_country: string | null
          expires_at: string | null
          failure_reason: string | null
          id: string
          is_over_18: boolean | null
          provider: string
          provider_session_id: string | null
          provider_verification_ref: string | null
          selfie_match: boolean | null
          status: string
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          document_country?: string | null
          expires_at?: string | null
          failure_reason?: string | null
          id?: string
          is_over_18?: boolean | null
          provider: string
          provider_session_id?: string | null
          provider_verification_ref?: string | null
          selfie_match?: boolean | null
          status?: string
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          document_country?: string | null
          expires_at?: string | null
          failure_reason?: string | null
          id?: string
          is_over_18?: boolean | null
          provider?: string
          provider_session_id?: string | null
          provider_verification_ref?: string | null
          selfie_match?: boolean | null
          status?: string
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      job_health: {
        Row: {
          job: string
          last_run_at: string
          updated_at: string
        }
        Insert: {
          job: string
          last_run_at: string
          updated_at?: string
        }
        Update: {
          job?: string
          last_run_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      key_packages: {
        Row: {
          created_at: string
          device_id: string
          id: string
          key_package_b64: string
        }
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          key_package_b64: string
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          key_package_b64?: string
        }
        Relationships: [
          {
            foreignKeyName: "key_packages_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      layover_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          session_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          session_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "layover_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "layover_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      layover_plan_stops: {
        Row: {
          created_at: string
          description: string | null
          duration_min: number
          id: string
          inside_airport: boolean
          lat: number | null
          lng: number | null
          location_label: string | null
          place_id: string | null
          recommendation_id: string | null
          session_id: string
          source: string
          stop_order: number
          title: string
          travel_min: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          duration_min?: number
          id?: string
          inside_airport?: boolean
          lat?: number | null
          lng?: number | null
          location_label?: string | null
          place_id?: string | null
          recommendation_id?: string | null
          session_id: string
          source?: string
          stop_order?: number
          title: string
          travel_min?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          duration_min?: number
          id?: string
          inside_airport?: boolean
          lat?: number | null
          lng?: number | null
          location_label?: string | null
          place_id?: string | null
          recommendation_id?: string | null
          session_id?: string
          source?: string
          stop_order?: number
          title?: string
          travel_min?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "layover_plan_stops_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "layover_recommendations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_plan_stops_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "layover_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      layover_recommendations: {
        Row: {
          activity_time_min: number
          city: string | null
          created_at: string
          description: string | null
          hard_return_time: string | null
          id: string
          inside_airport: boolean
          location_label: string | null
          neighborhood: string | null
          place_id: string | null
          plan_item_id: string | null
          rec_type: string
          return_buffer_min: number
          safety_rating: string
          session_id: string
          sort_order: number
          source: string
          status: string
          title: string
          travel_time_min: number
          warning_reason: string | null
        }
        Insert: {
          activity_time_min?: number
          city?: string | null
          created_at?: string
          description?: string | null
          hard_return_time?: string | null
          id?: string
          inside_airport?: boolean
          location_label?: string | null
          neighborhood?: string | null
          place_id?: string | null
          plan_item_id?: string | null
          rec_type: string
          return_buffer_min?: number
          safety_rating?: string
          session_id: string
          sort_order?: number
          source?: string
          status?: string
          title: string
          travel_time_min?: number
          warning_reason?: string | null
        }
        Update: {
          activity_time_min?: number
          city?: string | null
          created_at?: string
          description?: string | null
          hard_return_time?: string | null
          id?: string
          inside_airport?: boolean
          location_label?: string | null
          neighborhood?: string | null
          place_id?: string | null
          plan_item_id?: string | null
          rec_type?: string
          return_buffer_min?: number
          safety_rating?: string
          session_id?: string
          sort_order?: number
          source?: string
          status?: string
          title?: string
          travel_time_min?: number
          warning_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "layover_recommendations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "layover_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      layover_sessions: {
        Row: {
          airport_id: string | null
          arrival_time: string
          boarding_time: string | null
          canonical_city_id: string | null
          checked_bags: boolean
          comfort_level: string
          created_at: string
          departure_time: string
          flight_type: string
          id: string
          immigration_required: boolean
          layover_minutes: number | null
          lounge_access: boolean
          manual_airport_name: string | null
          manual_city: string | null
          manual_country: string | null
          manual_iata: string | null
          return_reminder_at: string | null
          share_city_status: boolean
          status: string
          trip_id: string | null
          updated_at: string
          user_id: string
          vibe_chips: string[]
          wants_to_leave: boolean
        }
        Insert: {
          airport_id?: string | null
          arrival_time: string
          boarding_time?: string | null
          canonical_city_id?: string | null
          checked_bags?: boolean
          comfort_level?: string
          created_at?: string
          departure_time: string
          flight_type?: string
          id?: string
          immigration_required?: boolean
          layover_minutes?: number | null
          lounge_access?: boolean
          manual_airport_name?: string | null
          manual_city?: string | null
          manual_country?: string | null
          manual_iata?: string | null
          return_reminder_at?: string | null
          share_city_status?: boolean
          status?: string
          trip_id?: string | null
          updated_at?: string
          user_id: string
          vibe_chips?: string[]
          wants_to_leave?: boolean
        }
        Update: {
          airport_id?: string | null
          arrival_time?: string
          boarding_time?: string | null
          canonical_city_id?: string | null
          checked_bags?: boolean
          comfort_level?: string
          created_at?: string
          departure_time?: string
          flight_type?: string
          id?: string
          immigration_required?: boolean
          layover_minutes?: number | null
          lounge_access?: boolean
          manual_airport_name?: string | null
          manual_city?: string | null
          manual_country?: string | null
          manual_iata?: string | null
          return_reminder_at?: string | null
          share_city_status?: boolean
          status?: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string
          vibe_chips?: string[]
          wants_to_leave?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "layover_sessions_airport_id_fkey"
            columns: ["airport_id"]
            isOneToOne: false
            referencedRelation: "airport_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_sessions_canonical_city_id_fkey"
            columns: ["canonical_city_id"]
            isOneToOne: false
            referencedRelation: "canonical_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "layover_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      live_place_recap_chapters: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body: string
          created_at: string
          id: string
          ordinal: number
          origin: string
          source_ids: string[]
          title: string
          version_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          created_at?: string
          id?: string
          ordinal: number
          origin?: string
          source_ids?: string[]
          title: string
          version_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          created_at?: string
          id?: string
          ordinal?: number
          origin?: string
          source_ids?: string[]
          title?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_place_recap_chapters_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_chapters_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recap_chapters_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "live_place_recap_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      live_place_recap_snapshots: {
        Row: {
          created_at: string
          id: string
          payload: Json
          snapshot_kind: string
          source_id: string
          version_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload: Json
          snapshot_kind: string
          source_id: string
          version_id: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json
          snapshot_kind?: string
          source_id?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_place_recap_snapshots_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "live_place_recap_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      live_place_recap_sources: {
        Row: {
          contributor_id: string | null
          created_at: string
          id: string
          ordinal: number
          post_id: string | null
          provenance: Json
          source_id: string
          source_type: string
          version_id: string
        }
        Insert: {
          contributor_id?: string | null
          created_at?: string
          id?: string
          ordinal?: number
          post_id?: string | null
          provenance?: Json
          source_id: string
          source_type: string
          version_id: string
        }
        Update: {
          contributor_id?: string | null
          created_at?: string
          id?: string
          ordinal?: number
          post_id?: string | null
          provenance?: Json
          source_id?: string
          source_type?: string
          version_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_place_recap_sources_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_sources_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recap_sources_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_sources_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "live_place_recap_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      live_place_recap_versions: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          place_snapshot: Json
          published_at: string | null
          published_by: string | null
          recap_id: string
          regenerates_version_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source_hash: string
          status: string
          summary: string
          title: string
          version_number: number
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          place_snapshot?: Json
          published_at?: string | null
          published_by?: string | null
          recap_id: string
          regenerates_version_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_hash: string
          status?: string
          summary?: string
          title?: string
          version_number: number
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          place_snapshot?: Json
          published_at?: string | null
          published_by?: string | null
          recap_id?: string
          regenerates_version_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_hash?: string
          status?: string
          summary?: string
          title?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "live_place_recap_versions_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_versions_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recap_versions_recap_id_fkey"
            columns: ["recap_id"]
            isOneToOne: false
            referencedRelation: "live_place_recaps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_versions_regenerates_version_id_fkey"
            columns: ["regenerates_version_id"]
            isOneToOne: false
            referencedRelation: "live_place_recap_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_versions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recap_versions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      live_place_recaps: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          created_at: string
          current_version_id: string | null
          id: string
          moment_id: string | null
          owner_id: string
          place_day_id: string | null
          place_id: string
          removed_at: string | null
          removed_by: string | null
          restored_at: string | null
          restored_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          created_at?: string
          current_version_id?: string | null
          id?: string
          moment_id?: string | null
          owner_id: string
          place_day_id?: string | null
          place_id: string
          removed_at?: string | null
          removed_by?: string | null
          restored_at?: string | null
          restored_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          created_at?: string
          current_version_id?: string | null
          id?: string
          moment_id?: string | null
          owner_id?: string
          place_day_id?: string | null
          place_id?: string
          removed_at?: string | null
          removed_by?: string | null
          restored_at?: string | null
          restored_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_place_recaps_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recaps_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "live_place_recap_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "shared_moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recaps_place_day_id_fkey"
            columns: ["place_day_id"]
            isOneToOne: false
            referencedRelation: "place_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_removed_by_fkey"
            columns: ["removed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "live_place_recaps_restored_by_fkey"
            columns: ["restored_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "live_place_recaps_restored_by_fkey"
            columns: ["restored_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      local_guide_contributions: {
        Row: {
          contribution_type: string
          created_at: string
          gem_id: string | null
          guide_id: string
          helpful_votes: number
          id: string
        }
        Insert: {
          contribution_type: string
          created_at?: string
          gem_id?: string | null
          guide_id: string
          helpful_votes?: number
          id?: string
        }
        Update: {
          contribution_type?: string
          created_at?: string
          gem_id?: string | null
          guide_id?: string
          helpful_votes?: number
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "local_guide_contributions_gem_id_fkey"
            columns: ["gem_id"]
            isOneToOne: false
            referencedRelation: "hidden_gems"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "local_guide_contributions_guide_id_fkey"
            columns: ["guide_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "local_guide_contributions_guide_id_fkey"
            columns: ["guide_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      local_guide_profiles: {
        Row: {
          accuracy_score: number | null
          bio: string | null
          city_expertise: string[] | null
          contribution_count: number
          created_at: string
          guide_level: number
          helpful_votes: number
          status: string
          updated_at: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          accuracy_score?: number | null
          bio?: string | null
          city_expertise?: string[] | null
          contribution_count?: number
          created_at?: string
          guide_level?: number
          helpful_votes?: number
          status?: string
          updated_at?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          accuracy_score?: number | null
          bio?: string | null
          city_expertise?: string[] | null
          contribution_count?: number
          created_at?: string
          guide_level?: number
          helpful_votes?: number
          status?: string
          updated_at?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "local_guide_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "local_guide_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      location_preferences: {
        Row: {
          discovery_visibility: string
          hotel_blur_enabled: boolean
          location_mode: string
          pulse_visibility: string
          safe_return_enabled: boolean
          sharing_paused: boolean
          trusted_circle_share: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          discovery_visibility?: string
          hotel_blur_enabled?: boolean
          location_mode?: string
          pulse_visibility?: string
          safe_return_enabled?: boolean
          sharing_paused?: boolean
          trusted_circle_share?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          discovery_visibility?: string
          hotel_blur_enabled?: boolean
          location_mode?: string
          pulse_visibility?: string
          safe_return_enabled?: boolean
          sharing_paused?: boolean
          trusted_circle_share?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      location_sessions: {
        Row: {
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          district: string | null
          ended_at: string | null
          expires_at: string | null
          id: string
          lat: number | null
          lng: number | null
          metadata: Json | null
          plan_item_id: string | null
          related_plan_id: string | null
          related_trip_id: string | null
          resolved_city: string | null
          resolved_country: string | null
          session_type: string
          started_at: string
          trip_id: string | null
          user_id: string
        }
        Insert: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          ended_at?: string | null
          expires_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          plan_item_id?: string | null
          related_plan_id?: string | null
          related_trip_id?: string | null
          resolved_city?: string | null
          resolved_country?: string | null
          session_type: string
          started_at?: string
          trip_id?: string | null
          user_id: string
        }
        Update: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          ended_at?: string | null
          expires_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          plan_item_id?: string | null
          related_plan_id?: string | null
          related_trip_id?: string | null
          resolved_city?: string | null
          resolved_country?: string | null
          session_type?: string
          started_at?: string
          trip_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_sessions_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "trip_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      location_snapshots: {
        Row: {
          accuracy_meters: number | null
          captured_at: string
          expires_at: string
          id: string
          lat: number
          lng: number
          source: string
          user_id: string
        }
        Insert: {
          accuracy_meters?: number | null
          captured_at?: string
          expires_at?: string
          id?: string
          lat: number
          lng: number
          source?: string
          user_id: string
        }
        Update: {
          accuracy_meters?: number | null
          captured_at?: string
          expires_at?: string
          id?: string
          lat?: number
          lng?: number
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      location_trust_events: {
        Row: {
          confidence: string
          created_at: string
          details: Json | null
          event_type: string
          id: string
          reviewed_at: string | null
          reviewed_by: string | null
          user_id: string
        }
        Insert: {
          confidence?: string
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          user_id: string
        }
        Update: {
          confidence?: string
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      map_pins: {
        Row: {
          category: string | null
          city: string | null
          created_at: string
          id: string
          is_private: boolean
          lat: number | null
          lng: number | null
          owner_id: string
          title: string
          trip_id: string | null
        }
        Insert: {
          category?: string | null
          city?: string | null
          created_at?: string
          id?: string
          is_private?: boolean
          lat?: number | null
          lng?: number | null
          owner_id: string
          title: string
          trip_id?: string | null
        }
        Update: {
          category?: string | null
          city?: string | null
          created_at?: string
          id?: string
          is_private?: boolean
          lat?: number | null
          lng?: number | null
          owner_id?: string
          title?: string
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "map_pins_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "map_pins_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "map_pins_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      media_assets: {
        Row: {
          alt_text: string | null
          caption: string | null
          created_at: string
          duration_ms: number | null
          height: number | null
          id: string
          media_type: string
          mime_type: string
          moderation_status: string
          owner_user_id: string
          processing_status: string
          public_url: string | null
          size_bytes: number
          source_type: string
          storage_bucket: string
          storage_path: string
          thumbnail_path: string | null
          thumbnail_url: string | null
          updated_at: string
          uploader_user_id: string
          version: number
          visibility: string
          width: number | null
        }
        Insert: {
          alt_text?: string | null
          caption?: string | null
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          media_type: string
          mime_type: string
          moderation_status?: string
          owner_user_id: string
          processing_status?: string
          public_url?: string | null
          size_bytes?: number
          source_type?: string
          storage_bucket: string
          storage_path: string
          thumbnail_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          uploader_user_id: string
          version?: number
          visibility?: string
          width?: number | null
        }
        Update: {
          alt_text?: string | null
          caption?: string | null
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          media_type?: string
          mime_type?: string
          moderation_status?: string
          owner_user_id?: string
          processing_status?: string
          public_url?: string | null
          size_bytes?: number
          source_type?: string
          storage_bucket?: string
          storage_path?: string
          thumbnail_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          uploader_user_id?: string
          version?: number
          visibility?: string
          width?: number | null
        }
        Relationships: []
      }
      media_attachments: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          is_cover: boolean
          media_asset_id: string
          position: number
          visibility_override: string | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          is_cover?: boolean
          media_asset_id: string
          position?: number
          visibility_override?: string | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          is_cover?: boolean
          media_asset_id?: string
          position?: number
          visibility_override?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_attachments_media_asset_id_fkey"
            columns: ["media_asset_id"]
            isOneToOne: false
            referencedRelation: "media_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      media_dedup_groups: {
        Row: {
          bucket_key: string
          canonical_place_id: string
          id: string
          member_count: number
          representative_media_id: string
          representative_phash: string | null
          sample_media_ids: string[]
          updated_at: string
        }
        Insert: {
          bucket_key: string
          canonical_place_id: string
          id?: string
          member_count?: number
          representative_media_id: string
          representative_phash?: string | null
          sample_media_ids?: string[]
          updated_at?: string
        }
        Update: {
          bucket_key?: string
          canonical_place_id?: string
          id?: string
          member_count?: number
          representative_media_id?: string
          representative_phash?: string | null
          sample_media_ids?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_dedup_groups_canonical_place_id_fkey"
            columns: ["canonical_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_dedup_groups_representative_media_id_fkey"
            columns: ["representative_media_id"]
            isOneToOne: false
            referencedRelation: "post_media"
            referencedColumns: ["id"]
          },
        ]
      }
      media_dedup_memberships: {
        Row: {
          created_at: string
          group_id: string
          media_id: string
        }
        Insert: {
          created_at?: string
          group_id: string
          media_id: string
        }
        Update: {
          created_at?: string
          group_id?: string
          media_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_dedup_memberships_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "media_dedup_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_dedup_memberships_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: true
            referencedRelation: "post_media"
            referencedColumns: ["id"]
          },
        ]
      }
      media_events: {
        Row: {
          event_type: string
          id: string
          occurred_at: string
          payload: Json
        }
        Insert: {
          event_type: string
          id?: string
          occurred_at?: string
          payload?: Json
        }
        Update: {
          event_type?: string
          id?: string
          occurred_at?: string
          payload?: Json
        }
        Relationships: []
      }
      media_ranking_snapshots: {
        Row: {
          final_score: number
          item_id: string
          position: number
          reason_codes: Json
          served_at: string
          session_id: string
          surface: string
          viewer_id: string
        }
        Insert: {
          final_score?: number
          item_id: string
          position?: number
          reason_codes?: Json
          served_at?: string
          session_id: string
          surface?: string
          viewer_id: string
        }
        Update: {
          final_score?: number
          item_id?: string
          position?: number
          reason_codes?: Json
          served_at?: string
          session_id?: string
          surface?: string
          viewer_id?: string
        }
        Relationships: []
      }
      media_stamp_reactions: {
        Row: {
          created_at: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_stamp_reactions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      meetup_invites: {
        Row: {
          id: string
          invited_at: string
          meetup_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          invited_at?: string
          meetup_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          invited_at?: string
          meetup_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetup_invites_meetup_id_fkey"
            columns: ["meetup_id"]
            isOneToOne: false
            referencedRelation: "meetups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_invites_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_invites_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      meetup_time_options: {
        Row: {
          confirmed: boolean
          created_at: string
          id: string
          label: string | null
          meetup_id: string
          proposed_date: string
          proposed_time: string | null
          time_block: string | null
        }
        Insert: {
          confirmed?: boolean
          created_at?: string
          id?: string
          label?: string | null
          meetup_id: string
          proposed_date: string
          proposed_time?: string | null
          time_block?: string | null
        }
        Update: {
          confirmed?: boolean
          created_at?: string
          id?: string
          label?: string | null
          meetup_id?: string
          proposed_date?: string
          proposed_time?: string | null
          time_block?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meetup_time_options_meetup_id_fkey"
            columns: ["meetup_id"]
            isOneToOne: false
            referencedRelation: "meetups"
            referencedColumns: ["id"]
          },
        ]
      }
      meetup_time_votes: {
        Row: {
          id: string
          option_id: string
          user_id: string
          vote: string
          voted_at: string
        }
        Insert: {
          id?: string
          option_id: string
          user_id: string
          vote: string
          voted_at?: string
        }
        Update: {
          id?: string
          option_id?: string
          user_id?: string
          vote?: string
          voted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetup_time_votes_option_id_fkey"
            columns: ["option_id"]
            isOneToOne: false
            referencedRelation: "meetup_time_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_time_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetup_time_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      meetups: {
        Row: {
          age_limit_enabled: boolean
          approximate_date: string | null
          chat_message_id: string | null
          chat_thread_id: string | null
          circle_owner_id: string | null
          created_at: string
          creator_id: string
          description: string | null
          ends_at: string | null
          id: string
          location_name: string | null
          max_age: number | null
          min_age: number | null
          starts_at: string | null
          status: string
          time_block: string | null
          title: string
          trip_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          age_limit_enabled?: boolean
          approximate_date?: string | null
          chat_message_id?: string | null
          chat_thread_id?: string | null
          circle_owner_id?: string | null
          created_at?: string
          creator_id: string
          description?: string | null
          ends_at?: string | null
          id?: string
          location_name?: string | null
          max_age?: number | null
          min_age?: number | null
          starts_at?: string | null
          status?: string
          time_block?: string | null
          title: string
          trip_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          age_limit_enabled?: boolean
          approximate_date?: string | null
          chat_message_id?: string | null
          chat_thread_id?: string | null
          circle_owner_id?: string | null
          created_at?: string
          creator_id?: string
          description?: string | null
          ends_at?: string | null
          id?: string
          location_name?: string | null
          max_age?: number | null
          min_age?: number | null
          starts_at?: string | null
          status?: string
          time_block?: string | null
          title?: string
          trip_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetups_chat_thread_id_fkey"
            columns: ["chat_thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetups_circle_owner_id_fkey"
            columns: ["circle_owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetups_circle_owner_id_fkey"
            columns: ["circle_owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "meetups_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetups_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "meetups_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      memories: {
        Row: {
          allowed_user_ids: string[]
          canonical_location_id: string | null
          caption: string | null
          created_at: string
          ends_at: string | null
          event_id: string | null
          hidden_user_ids: string[]
          id: string
          location_city: string | null
          location_country: string | null
          location_lat: number | null
          location_lng: number | null
          owner_id: string
          place_id: string | null
          starts_at: string | null
          state: string
          title: string | null
          trip_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          allowed_user_ids?: string[]
          canonical_location_id?: string | null
          caption?: string | null
          created_at?: string
          ends_at?: string | null
          event_id?: string | null
          hidden_user_ids?: string[]
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_lat?: number | null
          location_lng?: number | null
          owner_id: string
          place_id?: string | null
          starts_at?: string | null
          state?: string
          title?: string | null
          trip_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          allowed_user_ids?: string[]
          canonical_location_id?: string | null
          caption?: string | null
          created_at?: string
          ends_at?: string | null
          event_id?: string | null
          hidden_user_ids?: string[]
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_lat?: number | null
          location_lng?: number | null
          owner_id?: string
          place_id?: string | null
          starts_at?: string | null
          state?: string
          title?: string | null
          trip_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "memories_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memories_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_items: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          media_type: string
          media_url: string
          memory_id: string
          position: number
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          media_type?: string
          media_url: string
          memory_id: string
          position?: number
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          media_type?: string
          media_url?: string
          memory_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "memory_items_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_likes: {
        Row: {
          created_at: string
          memory_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          memory_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          memory_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_likes_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_saves: {
        Row: {
          created_at: string
          memory_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          memory_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          memory_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_saves_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_tags: {
        Row: {
          created_at: string
          memory_id: string
          status: string
          tagged_user_id: string
        }
        Insert: {
          created_at?: string
          memory_id: string
          status?: string
          tagged_user_id: string
        }
        Update: {
          created_at?: string
          memory_id?: string
          status?: string
          tagged_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_tags_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      message_reports: {
        Row: {
          created_at: string
          id: string
          message_id: string
          reason: string
          reporter_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_id: string
          reason: string
          reporter_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_id?: string
          reason?: string
          reporter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      message_requests: {
        Row: {
          created_at: string
          id: string
          preview_text: string | null
          recipient_id: string
          responded_at: string | null
          sender_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          preview_text?: string | null
          recipient_id: string
          responded_at?: string | null
          sender_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          preview_text?: string | null
          recipient_id?: string
          responded_at?: string | null
          sender_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_requests_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_requests_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "message_requests_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_requests_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      message_thread_members: {
        Row: {
          archived_at: string | null
          joined_at: string
          last_read_at: string | null
          left_at: string | null
          muted_at: string | null
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          joined_at?: string
          last_read_at?: string | null
          left_at?: string | null
          muted_at?: string | null
          role?: string
          thread_id: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          joined_at?: string
          last_read_at?: string | null
          left_at?: string | null
          muted_at?: string | null
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_thread_members_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_thread_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_thread_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      message_threads: {
        Row: {
          circle_owner_id: string | null
          created_at: string
          created_by: string | null
          id: string
          is_e2ee: boolean
          last_message_at: string | null
          status: string
          thread_type: string
          title: string | null
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          circle_owner_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_e2ee?: boolean
          last_message_at?: string | null
          status?: string
          thread_type?: string
          title?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          circle_owner_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_e2ee?: boolean
          last_message_at?: string | null
          status?: string
          thread_type?: string
          title?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_threads_circle_owner_id_fkey"
            columns: ["circle_owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_threads_circle_owner_id_fkey"
            columns: ["circle_owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "message_threads_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      message_translations: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string
          provider: string | null
          recipient_id: string
          source_language: string
          status: Database["public"]["Enums"]["translation_status"]
          target_language: string
          translated_body: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id: string
          provider?: string | null
          recipient_id: string
          source_language: string
          status?: Database["public"]["Enums"]["translation_status"]
          target_language: string
          translated_body?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string
          provider?: string | null
          recipient_id?: string
          source_language?: string
          status?: Database["public"]["Enums"]["translation_status"]
          target_language?: string
          translated_body?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_translations_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_translations_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "message_translations_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          ciphertext: string | null
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          language_detection_source: string | null
          media_duration_seconds: number | null
          media_thumbnail_url: string | null
          media_type: string | null
          media_url: string | null
          msg_type: string
          original_language: string | null
          reply_to_id: string | null
          sender_id: string
          sender_original_language: string | null
          subtype: string | null
          thread_id: string
          translated_body_json: Json | null
        }
        Insert: {
          body: string
          ciphertext?: string | null
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          language_detection_source?: string | null
          media_duration_seconds?: number | null
          media_thumbnail_url?: string | null
          media_type?: string | null
          media_url?: string | null
          msg_type?: string
          original_language?: string | null
          reply_to_id?: string | null
          sender_id: string
          sender_original_language?: string | null
          subtype?: string | null
          thread_id: string
          translated_body_json?: Json | null
        }
        Update: {
          body?: string
          ciphertext?: string | null
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          language_detection_source?: string | null
          media_duration_seconds?: number | null
          media_thumbnail_url?: string | null
          media_type?: string | null
          media_url?: string | null
          msg_type?: string
          original_language?: string | null
          reply_to_id?: string | null
          sender_id?: string
          sender_original_language?: string | null
          subtype?: string | null
          thread_id?: string
          translated_body_json?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_actions: {
        Row: {
          action_type: string
          created_at: string
          id: string
          metadata: Json | null
          performed_by: string | null
          reason: string | null
          target_user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          metadata?: Json | null
          performed_by?: string | null
          reason?: string | null
          target_user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          performed_by?: string | null
          reason?: string | null
          target_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "moderation_actions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "moderation_actions_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      moderation_reports: {
        Row: {
          category: string
          created_at: string
          details: string | null
          id: string
          image_url: string | null
          reporter_id: string
          resolved_at: string | null
          resolver_id: string | null
          resolver_note: string | null
          status: string
          subject_id: string
          subject_type: string
          subject_user_id: string | null
          thread_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          details?: string | null
          id?: string
          image_url?: string | null
          reporter_id: string
          resolved_at?: string | null
          resolver_id?: string | null
          resolver_note?: string | null
          status?: string
          subject_id: string
          subject_type: string
          subject_user_id?: string | null
          thread_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          details?: string | null
          id?: string
          image_url?: string | null
          reporter_id?: string
          resolved_at?: string | null
          resolver_id?: string | null
          resolver_note?: string | null
          status?: string
          subject_id?: string
          subject_type?: string
          subject_user_id?: string | null
          thread_id?: string | null
        }
        Relationships: []
      }
      neighborhood_areas: {
        Row: {
          category_scores: Json
          center_lat: number
          center_lng: number
          city_name: string
          computed_at: string
          confidence: string
          country: string | null
          created_at: string
          day_night: Json
          id: string
          name: string
          poi_counts: Json
          radius_m: number
          sample_size: number
          source: string
        }
        Insert: {
          category_scores?: Json
          center_lat: number
          center_lng: number
          city_name: string
          computed_at?: string
          confidence?: string
          country?: string | null
          created_at?: string
          day_night?: Json
          id?: string
          name: string
          poi_counts?: Json
          radius_m?: number
          sample_size?: number
          source: string
        }
        Update: {
          category_scores?: Json
          center_lat?: number
          center_lng?: number
          city_name?: string
          computed_at?: string
          confidence?: string
          country?: string | null
          created_at?: string
          day_night?: Json
          id?: string
          name?: string
          poi_counts?: Json
          radius_m?: number
          sample_size?: number
          source?: string
        }
        Relationships: []
      }
      notification_category_preferences: {
        Row: {
          category: string
          digest_enabled: boolean
          email_enabled: boolean
          in_app_enabled: boolean
          push_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          digest_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          push_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          digest_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          push_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_category_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_category_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      notification_delivery_attempts: {
        Row: {
          channel: string
          created_at: string
          error_message: string | null
          id: string
          metadata: Json
          notification_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json
          notification_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          error_message?: string | null
          id?: string
          metadata?: Json
          notification_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_delivery_attempts_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_delivery_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_delivery_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      notification_devices: {
        Row: {
          created_at: string
          id: string
          label: string | null
          last_used_at: string
          platform: string
          push_token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string
          platform?: string
          push_token: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string
          platform?: string
          push_token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          digests_enabled: boolean
          email_enabled: boolean
          in_app_enabled: boolean
          location_previews: boolean
          message_previews: boolean
          push_enabled: boolean
          quiet_end: string
          quiet_hours_enabled: boolean
          quiet_start: string
          safety_override: boolean
          timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          digests_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          location_previews?: boolean
          message_previews?: boolean
          push_enabled?: boolean
          quiet_end?: string
          quiet_hours_enabled?: boolean
          quiet_start?: string
          safety_override?: boolean
          timezone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          digests_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          location_previews?: boolean
          message_previews?: boolean
          push_enabled?: boolean
          quiet_end?: string
          quiet_hours_enabled?: boolean
          quiet_start?: string
          safety_override?: boolean
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      notifications: {
        Row: {
          action_url: string | null
          actor_id: string | null
          body: string
          category: string
          created_at: string
          dismissed_at: string | null
          event_type: string
          expires_at: string | null
          id: string
          image_url: string | null
          metadata: Json
          priority: string
          privacy_level: string
          read_at: string | null
          source_id: string | null
          source_type: string | null
          title: string
          user_id: string
        }
        Insert: {
          action_url?: string | null
          actor_id?: string | null
          body: string
          category: string
          created_at?: string
          dismissed_at?: string | null
          event_type: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          metadata?: Json
          priority?: string
          privacy_level?: string
          read_at?: string | null
          source_id?: string | null
          source_type?: string | null
          title: string
          user_id: string
        }
        Update: {
          action_url?: string | null
          actor_id?: string | null
          body?: string
          category?: string
          created_at?: string
          dismissed_at?: string | null
          event_type?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          metadata?: Json
          priority?: string
          privacy_level?: string
          read_at?: string | null
          source_id?: string | null
          source_type?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      passport_contribution_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          source_id: string | null
          source_type: string | null
          user_id: string
          verification_level: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          source_id?: string | null
          source_type?: string | null
          user_id: string
          verification_level?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          source_id?: string | null
          source_type?: string | null
          user_id?: string
          verification_level?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "passport_contribution_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_contribution_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      passport_memories: {
        Row: {
          body: string | null
          category: string | null
          city: string | null
          country: string | null
          created_at: string
          description: string | null
          earned_at: string
          id: string
          media_type: string | null
          metadata: Json | null
          neighborhood: string | null
          photo_url: string | null
          place_id: string | null
          plan_id: string | null
          source_id: string | null
          source_type: string | null
          status: string
          suggestion_reason: string | null
          title: string | null
          trip_id: string | null
          updated_at: string
          user_id: string
          verification_level: string
          visibility: string
        }
        Insert: {
          body?: string | null
          category?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          description?: string | null
          earned_at?: string
          id?: string
          media_type?: string | null
          metadata?: Json | null
          neighborhood?: string | null
          photo_url?: string | null
          place_id?: string | null
          plan_id?: string | null
          source_id?: string | null
          source_type?: string | null
          status?: string
          suggestion_reason?: string | null
          title?: string | null
          trip_id?: string | null
          updated_at?: string
          user_id: string
          verification_level?: string
          visibility?: string
        }
        Update: {
          body?: string | null
          category?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          description?: string | null
          earned_at?: string
          id?: string
          media_type?: string | null
          metadata?: Json | null
          neighborhood?: string | null
          photo_url?: string | null
          place_id?: string | null
          plan_id?: string | null
          source_id?: string | null
          source_type?: string | null
          status?: string
          suggestion_reason?: string | null
          title?: string | null
          trip_id?: string | null
          updated_at?: string
          user_id?: string
          verification_level?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_memories_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "trip_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_memories_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_memories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_memories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      passport_postcards: {
        Row: {
          caption: string | null
          created_at: string
          deleted_at: string | null
          has_video: boolean
          id: string
          location_city: string | null
          location_country: string | null
          location_name: string | null
          location_verified: boolean
          media_count: number
          media_url: string
          note: string | null
          pinned_at: string | null
          post_id: string
          primary_media_type: string | null
          stamp_eligible: boolean
          stamp_reason: string | null
          stamp_revoked: boolean
          stamp_revoked_at: string | null
          stamp_revoked_by: string | null
          stamp_revoked_reason: string | null
          stamp_style: string | null
          status: Database["public"]["Enums"]["post_status"]
          updated_at: string
          user_id: string
          verification_method: Database["public"]["Enums"]["verification_method"]
          verified_at: string | null
          verified_distance_meters: number | null
          visibility: Database["public"]["Enums"]["post_visibility"]
        }
        Insert: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          has_video?: boolean
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          location_verified?: boolean
          media_count?: number
          media_url: string
          note?: string | null
          pinned_at?: string | null
          post_id: string
          primary_media_type?: string | null
          stamp_eligible?: boolean
          stamp_reason?: string | null
          stamp_revoked?: boolean
          stamp_revoked_at?: string | null
          stamp_revoked_by?: string | null
          stamp_revoked_reason?: string | null
          stamp_style?: string | null
          status?: Database["public"]["Enums"]["post_status"]
          updated_at?: string
          user_id: string
          verification_method?: Database["public"]["Enums"]["verification_method"]
          verified_at?: string | null
          verified_distance_meters?: number | null
          visibility?: Database["public"]["Enums"]["post_visibility"]
        }
        Update: {
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          has_video?: boolean
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          location_verified?: boolean
          media_count?: number
          media_url?: string
          note?: string | null
          pinned_at?: string | null
          post_id?: string
          primary_media_type?: string | null
          stamp_eligible?: boolean
          stamp_reason?: string | null
          stamp_revoked?: boolean
          stamp_revoked_at?: string | null
          stamp_revoked_by?: string | null
          stamp_revoked_reason?: string | null
          stamp_style?: string | null
          status?: Database["public"]["Enums"]["post_status"]
          updated_at?: string
          user_id?: string
          verification_method?: Database["public"]["Enums"]["verification_method"]
          verified_at?: string | null
          verified_distance_meters?: number | null
          visibility?: Database["public"]["Enums"]["post_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "passport_postcards_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: true
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_postcards_stamp_revoked_by_fkey"
            columns: ["stamp_revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_postcards_stamp_revoked_by_fkey"
            columns: ["stamp_revoked_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "passport_postcards_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_postcards_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      passport_stamps: {
        Row: {
          artwork_override: Json | null
          awarded_at: string
          catalog_id: string | null
          city: string | null
          country: string | null
          created_at: string
          id: string
          neighborhood: string | null
          place_id: string | null
          plan_id: string | null
          source_type: string
          stamp_type: string
          trip_id: string | null
          updated_at: string
          user_id: string
          verification_level: string
          visibility: string
        }
        Insert: {
          artwork_override?: Json | null
          awarded_at?: string
          catalog_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          neighborhood?: string | null
          place_id?: string | null
          plan_id?: string | null
          source_type?: string
          stamp_type: string
          trip_id?: string | null
          updated_at?: string
          user_id: string
          verification_level?: string
          visibility?: string
        }
        Update: {
          artwork_override?: Json | null
          awarded_at?: string
          catalog_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          neighborhood?: string | null
          place_id?: string | null
          plan_id?: string | null
          source_type?: string
          stamp_type?: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string
          verification_level?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_stamps_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_stamps_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "trip_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_stamps_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_stamps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_stamps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      passport_stamps_gps: {
        Row: {
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          district: string | null
          id: string
          lat: number | null
          lng: number | null
          metadata: Json | null
          related_postcard_id: string | null
          related_trip_id: string | null
          source: string
          stamp_type: string
          unlocked_at: string
          user_id: string
        }
        Insert: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          related_postcard_id?: string | null
          related_trip_id?: string | null
          source?: string
          stamp_type: string
          unlocked_at?: string
          user_id: string
        }
        Update: {
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          related_postcard_id?: string | null
          related_trip_id?: string | null
          source?: string
          stamp_type?: string
          unlocked_at?: string
          user_id?: string
        }
        Relationships: []
      }
      passport_visibility_preferences: {
        Row: {
          default_memory_visibility: string
          default_stamp_visibility: string
          map_visible: string
          memories_visible: string
          show_city_map: boolean
          show_neighborhoods: boolean
          show_plan_stamps: boolean
          show_safe_return_stamps: boolean
          stamps_visible: string
          updated_at: string
          user_id: string
        }
        Insert: {
          default_memory_visibility?: string
          default_stamp_visibility?: string
          map_visible?: string
          memories_visible?: string
          show_city_map?: boolean
          show_neighborhoods?: boolean
          show_plan_stamps?: boolean
          show_safe_return_stamps?: boolean
          stamps_visible?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          default_memory_visibility?: string
          default_stamp_visibility?: string
          map_visible?: string
          memories_visible?: string
          show_city_map?: boolean
          show_neighborhoods?: boolean
          show_plan_stamps?: boolean
          show_safe_return_stamps?: boolean
          stamps_visible?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_visibility_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passport_visibility_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      place_ai_summaries: {
        Row: {
          generated_at: string
          place_id: string
          post_ids_used: string[]
          text: string
        }
        Insert: {
          generated_at?: string
          place_id: string
          post_ids_used?: string[]
          text: string
        }
        Update: {
          generated_at?: string
          place_id?: string
          post_ids_used?: string[]
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_ai_summaries_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: true
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_best_of: {
        Row: {
          food_nearby: Json
          place_id: string
          top_experiences: Json
          top_photos: Json
          top_videos: Json
          top_viewpoints: Json
          updated_at: string
        }
        Insert: {
          food_nearby?: Json
          place_id: string
          top_experiences?: Json
          top_photos?: Json
          top_videos?: Json
          top_viewpoints?: Json
          updated_at?: string
        }
        Update: {
          food_nearby?: Json
          place_id?: string
          top_experiences?: Json
          top_photos?: Json
          top_videos?: Json
          top_viewpoints?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_best_of_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: true
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_cache_invalidation_queue: {
        Row: {
          locked_by: string | null
          locked_until: string | null
          place_id: string
          queued_at: string
          status: string
        }
        Insert: {
          locked_by?: string | null
          locked_until?: string | null
          place_id: string
          queued_at?: string
          status?: string
        }
        Update: {
          locked_by?: string | null
          locked_until?: string | null
          place_id?: string
          queued_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_cache_invalidation_queue_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: true
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_coverage_buckets: {
        Row: {
          bucket: string
          canonical_place_id: string
          last_post_at: string | null
          post_count: number
        }
        Insert: {
          bucket: string
          canonical_place_id: string
          last_post_at?: string | null
          post_count?: number
        }
        Update: {
          bucket?: string
          canonical_place_id?: string
          last_post_at?: string | null
          post_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "place_coverage_buckets_canonical_place_id_fkey"
            columns: ["canonical_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_days: {
        Row: {
          archived_at: string | null
          closing_at: string | null
          created_at: string
          id: string
          local_date: string
          opened_at: string
          place_id: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          closing_at?: string | null
          created_at?: string
          id?: string
          local_date: string
          opened_at?: string
          place_id: string
          status?: string
          timezone: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          closing_at?: string | null
          created_at?: string
          id?: string
          local_date?: string
          opened_at?: string
          place_id?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_days_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_image_reports: {
        Row: {
          confidence_adjustment: number | null
          created_at: string
          id: string
          image_url: string
          place_id: string
          report_reason: string
          reported_by: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
        }
        Insert: {
          confidence_adjustment?: number | null
          created_at?: string
          id?: string
          image_url: string
          place_id: string
          report_reason?: string
          reported_by?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          confidence_adjustment?: number | null
          created_at?: string
          id?: string
          image_url?: string
          place_id?: string
          report_reason?: string
          reported_by?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_image_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "place_image_reports_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "place_image_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "place_image_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      place_living_cache: {
        Row: {
          cached_at: string
          payload: Json
          place_id: string
          sparse: boolean
        }
        Insert: {
          cached_at?: string
          payload: Json
          place_id: string
          sparse?: boolean
        }
        Update: {
          cached_at?: string
          payload?: Json
          place_id?: string
          sparse?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "place_living_cache_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: true
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_merge_log: {
        Row: {
          action: string
          admin_id: string | null
          affected_place_id: string
          created_at: string
          id: string
          ref_count: number
          survivor_place_id: string
        }
        Insert: {
          action: string
          admin_id?: string | null
          affected_place_id: string
          created_at?: string
          id?: string
          ref_count?: number
          survivor_place_id: string
        }
        Update: {
          action?: string
          admin_id?: string | null
          affected_place_id?: string
          created_at?: string
          id?: string
          ref_count?: number
          survivor_place_id?: string
        }
        Relationships: []
      }
      place_mismatch_reports: {
        Row: {
          created_at: string
          id: string
          post_id: string
          reason: string | null
          reported_place_id: string | null
          reporter_id: string
          resolved_action: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          reason?: string | null
          reported_place_id?: string | null
          reporter_id: string
          resolved_action?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          reason?: string | null
          reported_place_id?: string | null
          reporter_id?: string
          resolved_action?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_mismatch_reports_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "place_mismatch_reports_reported_place_id_fkey"
            columns: ["reported_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_profiles: {
        Row: {
          address: string | null
          category: string | null
          city: string | null
          country_code: string | null
          created_at: string
          district: string | null
          id: string
          lat: number | null
          lng: number | null
          metadata: Json | null
          name: string
          osm_id: string | null
          phone: string | null
          place_type: string
          safety_note: string | null
          status: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
          website: string | null
        }
        Insert: {
          address?: string | null
          category?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          name: string
          osm_id?: string | null
          phone?: string | null
          place_type?: string
          safety_note?: string | null
          status?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          website?: string | null
        }
        Update: {
          address?: string | null
          category?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          district?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          name?: string
          osm_id?: string | null
          phone?: string | null
          place_type?: string
          safety_note?: string | null
          status?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
          website?: string | null
        }
        Relationships: []
      }
      place_top_contributors: {
        Row: {
          contribution_count: number
          place_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          contribution_count?: number
          place_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          contribution_count?: number
          place_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_top_contributors_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      place_votes: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          user_id: string
          vote: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          user_id: string
          vote: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          user_id?: string
          vote?: string
        }
        Relationships: [
          {
            foreignKeyName: "place_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "place_votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      places: {
        Row: {
          address: string | null
          canonical_location_id: string | null
          city: string | null
          country_code: string | null
          created_at: string
          field_freshness: Json
          geog: unknown
          header_image_generated_id: string | null
          id: string
          image_accuracy_status: string
          image_source_type: string | null
          latitude: number | null
          longitude: number | null
          merged_into_place_id: string | null
          name: string
          neighborhood: string | null
          normalized_name: string
          primary_category: string
          status: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          canonical_location_id?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          field_freshness?: Json
          geog?: unknown
          header_image_generated_id?: string | null
          id?: string
          image_accuracy_status?: string
          image_source_type?: string | null
          latitude?: number | null
          longitude?: number | null
          merged_into_place_id?: string | null
          name: string
          neighborhood?: string | null
          normalized_name: string
          primary_category?: string
          status?: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          canonical_location_id?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          field_freshness?: Json
          geog?: unknown
          header_image_generated_id?: string | null
          id?: string
          image_accuracy_status?: string
          image_source_type?: string | null
          latitude?: number | null
          longitude?: number | null
          merged_into_place_id?: string | null
          name?: string
          neighborhood?: string | null
          normalized_name?: string
          primary_category?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "places_canonical_location_id_fkey"
            columns: ["canonical_location_id"]
            isOneToOne: false
            referencedRelation: "canonical_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "places_header_image_generated_id_fkey"
            columns: ["header_image_generated_id"]
            isOneToOne: false
            referencedRelation: "generated_visuals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "places_merged_into_place_id_fkey"
            columns: ["merged_into_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_attendance_events: {
        Row: {
          actor_id: string | null
          created_at: string
          details: Json | null
          event_type: string
          geofence_id: string | null
          id: string
          metadata: Json | null
          plan_geofence_id: string | null
          trip_id: string | null
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          event_type: string
          geofence_id?: string | null
          id?: string
          metadata?: Json | null
          plan_geofence_id?: string | null
          trip_id?: string | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          details?: Json | null
          event_type?: string
          geofence_id?: string | null
          id?: string
          metadata?: Json | null
          plan_geofence_id?: string | null
          trip_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_attendance_events_geofence_id_fkey"
            columns: ["geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_attendance_events_plan_geofence_id_fkey"
            columns: ["plan_geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_attendance_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_attendance_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_attendance_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      plan_checkins: {
        Row: {
          checked_in_at: string | null
          geofence_id: string | null
          id: string
          override_by: string | null
          override_note: string | null
          plan_geofence_id: string | null
          status: string
          trip_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          checked_in_at?: string | null
          geofence_id?: string | null
          id?: string
          override_by?: string | null
          override_note?: string | null
          plan_geofence_id?: string | null
          status?: string
          trip_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          checked_in_at?: string | null
          geofence_id?: string | null
          id?: string
          override_by?: string | null
          override_note?: string | null
          plan_geofence_id?: string | null
          status?: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_checkins_geofence_id_fkey"
            columns: ["geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_checkins_plan_geofence_id_fkey"
            columns: ["plan_geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_checkins_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      plan_editors: {
        Row: {
          trip_id: string
          user_id: string
        }
        Insert: {
          trip_id: string
          user_id: string
        }
        Update: {
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_editors_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_geofences: {
        Row: {
          arrival_status: string
          arrival_status_visible: boolean
          check_in_radius_m: number
          check_in_required: boolean
          check_in_window_end: string | null
          check_in_window_start: string | null
          city: string | null
          created_at: string
          created_by: string | null
          exact_visibility: string | null
          host_enabled: boolean
          host_revealed: boolean
          id: string
          last_triggered_at: string | null
          lat: number | null
          lng: number | null
          location_name: string | null
          message_template: string | null
          neighborhood: string | null
          no_show_affects_reliability: boolean
          notify_members: boolean
          plan_item_id: string | null
          public_preview_level: string | null
          trigger_type: string
          trip_id: string
          updated_at: string
          venue_name: string | null
          visibility: string
          window_end: string | null
          window_start: string | null
          zone_id: string | null
        }
        Insert: {
          arrival_status?: string
          arrival_status_visible?: boolean
          check_in_radius_m?: number
          check_in_required?: boolean
          check_in_window_end?: string | null
          check_in_window_start?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          exact_visibility?: string | null
          host_enabled?: boolean
          host_revealed?: boolean
          id?: string
          last_triggered_at?: string | null
          lat?: number | null
          lng?: number | null
          location_name?: string | null
          message_template?: string | null
          neighborhood?: string | null
          no_show_affects_reliability?: boolean
          notify_members?: boolean
          plan_item_id?: string | null
          public_preview_level?: string | null
          trigger_type?: string
          trip_id: string
          updated_at?: string
          venue_name?: string | null
          visibility?: string
          window_end?: string | null
          window_start?: string | null
          zone_id?: string | null
        }
        Update: {
          arrival_status?: string
          arrival_status_visible?: boolean
          check_in_radius_m?: number
          check_in_required?: boolean
          check_in_window_end?: string | null
          check_in_window_start?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          exact_visibility?: string | null
          host_enabled?: boolean
          host_revealed?: boolean
          id?: string
          last_triggered_at?: string | null
          lat?: number | null
          lng?: number | null
          location_name?: string | null
          message_template?: string | null
          neighborhood?: string | null
          no_show_affects_reliability?: boolean
          notify_members?: boolean
          plan_item_id?: string | null
          public_preview_level?: string | null
          trigger_type?: string
          trip_id?: string
          updated_at?: string
          venue_name?: string | null
          visibility?: string
          window_end?: string | null
          window_start?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_geofences_plan_item_id_fkey"
            columns: ["plan_item_id"]
            isOneToOne: false
            referencedRelation: "trip_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_geofences_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_geofences_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "geo_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      portava_featured: {
        Row: {
          approved_by: string | null
          category: Database["public"]["Enums"]["portava_featured_category"]
          created_at: string
          creator_permission_granted_at: string | null
          creator_permission_requested_at: string | null
          featured_at: string
          id: string
          post_id: string
          status: string
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          category: Database["public"]["Enums"]["portava_featured_category"]
          created_at?: string
          creator_permission_granted_at?: string | null
          creator_permission_requested_at?: string | null
          featured_at?: string
          id?: string
          post_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          category?: Database["public"]["Enums"]["portava_featured_category"]
          created_at?: string
          creator_permission_granted_at?: string | null
          creator_permission_requested_at?: string | null
          featured_at?: string
          id?: string
          post_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "portava_featured_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portava_featured_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "portava_featured_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_bucket_ledger: {
        Row: {
          bucket: string
          canonical_place_id: string
          created_at: string
          post_id: string
        }
        Insert: {
          bucket: string
          canonical_place_id: string
          created_at?: string
          post_id: string
        }
        Update: {
          bucket?: string
          canonical_place_id?: string
          created_at?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_bucket_ledger_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_edits: {
        Row: {
          edited_at: string
          id: string
          new_content: string | null
          old_content: string | null
          post_id: string
          user_id: string
        }
        Insert: {
          edited_at?: string
          id?: string
          new_content?: string | null
          old_content?: string | null
          post_id: string
          user_id: string
        }
        Update: {
          edited_at?: string
          id?: string
          new_content?: string | null
          old_content?: string | null
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_edits_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_hides: {
        Row: {
          hidden_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          hidden_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          hidden_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_hides_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_impressions: {
        Row: {
          created_at: string
          id: string
          post_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      post_media: {
        Row: {
          canonical_place_id: string | null
          created_at: string
          dedup_processed: boolean
          duration_seconds: number | null
          file_size_bytes: number | null
          height: number | null
          id: string
          media_type: string
          mime_type: string
          moderation_status: string
          phash: string | null
          post_id: string
          processing_status: string
          public_url: string
          sort_order: number
          stamp_overlay: Json | null
          storage_bucket: string
          storage_path: string
          thumbnail_storage_path: string | null
          thumbnail_url: string | null
          updated_at: string
          user_id: string
          width: number | null
        }
        Insert: {
          canonical_place_id?: string | null
          created_at?: string
          dedup_processed?: boolean
          duration_seconds?: number | null
          file_size_bytes?: number | null
          height?: number | null
          id?: string
          media_type: string
          mime_type: string
          moderation_status?: string
          phash?: string | null
          post_id: string
          processing_status?: string
          public_url?: string
          sort_order?: number
          stamp_overlay?: Json | null
          storage_bucket?: string
          storage_path?: string
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
          width?: number | null
        }
        Update: {
          canonical_place_id?: string | null
          created_at?: string
          dedup_processed?: boolean
          duration_seconds?: number | null
          file_size_bytes?: number | null
          height?: number | null
          id?: string
          media_type?: string
          mime_type?: string
          moderation_status?: string
          phash?: string | null
          post_id?: string
          processing_status?: string
          public_url?: string
          sort_order?: number
          stamp_overlay?: Json | null
          storage_bucket?: string
          storage_path?: string
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "post_media_canonical_place_id_fkey"
            columns: ["canonical_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_media_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_reactions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_saves: {
        Row: {
          created_at: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_saves_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_saves_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      post_shares: {
        Row: {
          created_at: string
          id: string
          post_id: string
          target: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          target: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          target?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_shares_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          add_to_passport: boolean
          age_max: number | null
          age_min: number | null
          age_restriction_enabled: boolean
          author_id: string
          bucket_classified: boolean
          canonical_location_id: string | null
          canonical_place_id: string | null
          category: string | null
          comment_count: number
          comments_setting: string
          content: string
          created_at: string
          created_by: string | null
          delayed_location_reason: string | null
          deleted_at: string | null
          exited_geofence_at: string | null
          filter_id: string
          filter_intensity: number
          geo_restriction: string | null
          geofence_radius_meters: number
          geog: unknown
          geotag_credit_awarded: boolean
          geotag_verified: boolean
          has_video: boolean
          id: string
          like_count: number
          likes_hidden: boolean
          location_city: string | null
          location_country: string | null
          location_distance_meters: number | null
          location_lat: number | null
          location_lng: number | null
          location_name: string | null
          location_place_id: string | null
          location_privacy_mode: Database["public"]["Enums"]["post_location_privacy_mode"]
          location_sensitivity_level: Database["public"]["Enums"]["location_sensitivity_level"]
          location_source: Database["public"]["Enums"]["location_source"]
          location_verified: boolean
          location_verified_at: string | null
          media_count: number
          media_duration_seconds: number | null
          media_thumbnail_url: string | null
          media_type: string | null
          media_urls: string[]
          original_language: string | null
          original_lat: number | null
          original_lng: number | null
          post_buckets: string[] | null
          post_status: Database["public"]["Enums"]["delayed_post_status"]
          primary_media_type: string | null
          public_lat: number | null
          public_lng: number | null
          public_location_label: string | null
          publish_after_exit: boolean
          publish_after_time: string | null
          publish_at: string | null
          publish_eligible_at: string | null
          published_at: string | null
          reposting_disabled: boolean
          save_count: number
          share_count: number
          sharing_disabled: boolean
          source: string
          status: Database["public"]["Enums"]["post_status"]
          trip_id: string | null
          updated_at: string
          updated_by: string | null
          user_gps_lat: number | null
          user_gps_lng: number | null
          venue_id: string | null
          venue_name: string | null
          visibility: Database["public"]["Enums"]["post_visibility"]
        }
        Insert: {
          add_to_passport?: boolean
          age_max?: number | null
          age_min?: number | null
          age_restriction_enabled?: boolean
          author_id: string
          bucket_classified?: boolean
          canonical_location_id?: string | null
          canonical_place_id?: string | null
          category?: string | null
          comment_count?: number
          comments_setting?: string
          content?: string
          created_at?: string
          created_by?: string | null
          delayed_location_reason?: string | null
          deleted_at?: string | null
          exited_geofence_at?: string | null
          filter_id?: string
          filter_intensity?: number
          geo_restriction?: string | null
          geofence_radius_meters?: number
          geog?: unknown
          geotag_credit_awarded?: boolean
          geotag_verified?: boolean
          has_video?: boolean
          id?: string
          like_count?: number
          likes_hidden?: boolean
          location_city?: string | null
          location_country?: string | null
          location_distance_meters?: number | null
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          location_place_id?: string | null
          location_privacy_mode?: Database["public"]["Enums"]["post_location_privacy_mode"]
          location_sensitivity_level?: Database["public"]["Enums"]["location_sensitivity_level"]
          location_source?: Database["public"]["Enums"]["location_source"]
          location_verified?: boolean
          location_verified_at?: string | null
          media_count?: number
          media_duration_seconds?: number | null
          media_thumbnail_url?: string | null
          media_type?: string | null
          media_urls?: string[]
          original_language?: string | null
          original_lat?: number | null
          original_lng?: number | null
          post_buckets?: string[] | null
          post_status?: Database["public"]["Enums"]["delayed_post_status"]
          primary_media_type?: string | null
          public_lat?: number | null
          public_lng?: number | null
          public_location_label?: string | null
          publish_after_exit?: boolean
          publish_after_time?: string | null
          publish_at?: string | null
          publish_eligible_at?: string | null
          published_at?: string | null
          reposting_disabled?: boolean
          save_count?: number
          share_count?: number
          sharing_disabled?: boolean
          source?: string
          status?: Database["public"]["Enums"]["post_status"]
          trip_id?: string | null
          updated_at?: string
          updated_by?: string | null
          user_gps_lat?: number | null
          user_gps_lng?: number | null
          venue_id?: string | null
          venue_name?: string | null
          visibility?: Database["public"]["Enums"]["post_visibility"]
        }
        Update: {
          add_to_passport?: boolean
          age_max?: number | null
          age_min?: number | null
          age_restriction_enabled?: boolean
          author_id?: string
          bucket_classified?: boolean
          canonical_location_id?: string | null
          canonical_place_id?: string | null
          category?: string | null
          comment_count?: number
          comments_setting?: string
          content?: string
          created_at?: string
          created_by?: string | null
          delayed_location_reason?: string | null
          deleted_at?: string | null
          exited_geofence_at?: string | null
          filter_id?: string
          filter_intensity?: number
          geo_restriction?: string | null
          geofence_radius_meters?: number
          geog?: unknown
          geotag_credit_awarded?: boolean
          geotag_verified?: boolean
          has_video?: boolean
          id?: string
          like_count?: number
          likes_hidden?: boolean
          location_city?: string | null
          location_country?: string | null
          location_distance_meters?: number | null
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          location_place_id?: string | null
          location_privacy_mode?: Database["public"]["Enums"]["post_location_privacy_mode"]
          location_sensitivity_level?: Database["public"]["Enums"]["location_sensitivity_level"]
          location_source?: Database["public"]["Enums"]["location_source"]
          location_verified?: boolean
          location_verified_at?: string | null
          media_count?: number
          media_duration_seconds?: number | null
          media_thumbnail_url?: string | null
          media_type?: string | null
          media_urls?: string[]
          original_language?: string | null
          original_lat?: number | null
          original_lng?: number | null
          post_buckets?: string[] | null
          post_status?: Database["public"]["Enums"]["delayed_post_status"]
          primary_media_type?: string | null
          public_lat?: number | null
          public_lng?: number | null
          public_location_label?: string | null
          publish_after_exit?: boolean
          publish_after_time?: string | null
          publish_at?: string | null
          publish_eligible_at?: string | null
          published_at?: string | null
          reposting_disabled?: boolean
          save_count?: number
          share_count?: number
          sharing_disabled?: boolean
          source?: string
          status?: Database["public"]["Enums"]["post_status"]
          trip_id?: string | null
          updated_at?: string
          updated_by?: string | null
          user_gps_lat?: number | null
          user_gps_lng?: number | null
          venue_id?: string | null
          venue_name?: string | null
          visibility?: Database["public"]["Enums"]["post_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "posts_canonical_location_id_fkey"
            columns: ["canonical_location_id"]
            isOneToOne: false
            referencedRelation: "canonical_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_canonical_place_id_fkey"
            columns: ["canonical_place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "posts_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      posts_comments: {
        Row: {
          body: string
          created_at: string
          deleted_at: string | null
          id: string
          original_language: string | null
          parent_comment_id: string | null
          post_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          original_language?: string | null
          parent_comment_id?: string | null
          post_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          original_language?: string | null
          parent_comment_id?: string | null
          post_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "posts_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts_likes: {
        Row: {
          created_at: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      price_baselines: {
        Row: {
          category: string
          city: string | null
          confidence: string
          country: string | null
          created_at: string
          currency: string
          daily_amount: number
          id: string
          last_verified_at: string
          source_note: string | null
          tier: string
          updated_at: string
          verified_by: string | null
        }
        Insert: {
          category: string
          city?: string | null
          confidence?: string
          country?: string | null
          created_at?: string
          currency?: string
          daily_amount: number
          id?: string
          last_verified_at?: string
          source_note?: string | null
          tier: string
          updated_at?: string
          verified_by?: string | null
        }
        Update: {
          category?: string
          city?: string | null
          confidence?: string
          country?: string | null
          created_at?: string
          currency?: string
          daily_amount?: number
          id?: string
          last_verified_at?: string
          source_note?: string | null
          tier?: string
          updated_at?: string
          verified_by?: string | null
        }
        Relationships: []
      }
      profile_emergency_contacts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          label: string
          name: string
          notify_method: string
          phone: string | null
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          label?: string
          name: string
          notify_method?: string
          phone?: string | null
          sort_order?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          label?: string
          name?: string
          notify_method?: string
          phone?: string | null
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profile_privacy_settings: {
        Row: {
          allow_follow: boolean
          allow_friend_requests: boolean
          allow_messages_from: string
          allow_profile_discovery: boolean
          allow_tagging: boolean
          delayed_posting_default: boolean
          precise_location_visible: boolean
          profile_visibility: string
          show_current_city: boolean
          show_followers: boolean
          show_friends: boolean
          show_home_country: boolean
          show_past_trips: boolean
          show_posts: boolean
          show_real_name: boolean
          show_stamps: boolean
          show_upcoming_trips: boolean
          show_visited_places: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_follow?: boolean
          allow_friend_requests?: boolean
          allow_messages_from?: string
          allow_profile_discovery?: boolean
          allow_tagging?: boolean
          delayed_posting_default?: boolean
          precise_location_visible?: boolean
          profile_visibility?: string
          show_current_city?: boolean
          show_followers?: boolean
          show_friends?: boolean
          show_home_country?: boolean
          show_past_trips?: boolean
          show_posts?: boolean
          show_real_name?: boolean
          show_stamps?: boolean
          show_upcoming_trips?: boolean
          show_visited_places?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_follow?: boolean
          allow_friend_requests?: boolean
          allow_messages_from?: string
          allow_profile_discovery?: boolean
          allow_tagging?: boolean
          delayed_posting_default?: boolean
          precise_location_visible?: boolean
          profile_visibility?: string
          show_current_city?: boolean
          show_followers?: boolean
          show_friends?: boolean
          show_home_country?: boolean
          show_past_trips?: boolean
          show_posts?: boolean
          show_real_name?: boolean
          show_stamps?: boolean
          show_upcoming_trips?: boolean
          show_visited_places?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profile_views: {
        Row: {
          id: string
          target_id: string
          viewed_at: string
          viewer_id: string | null
        }
        Insert: {
          id?: string
          target_id: string
          viewed_at?: string
          viewer_id?: string | null
        }
        Update: {
          id?: string
          target_id?: string
          viewed_at?: string
          viewer_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_status: string
          auto_translate_messages: boolean
          availability_tags: string[] | null
          avatar_image_height: number | null
          avatar_image_width: number | null
          avatar_url: string | null
          bio: string | null
          bio_original_language: string | null
          buddy_verified_at: string | null
          budget_style: string | null
          city: string | null
          comfort_level: string | null
          country: string | null
          country_code: string | null
          cover_image_height: number | null
          cover_image_width: number | null
          cover_photo_url: string | null
          created_at: string
          current_city: string | null
          date_of_birth: string | null
          default_language: string | null
          display_name: string | null
          dob_verified: boolean
          expo_push_token: string | null
          featured_count: number
          flag_emoji: string | null
          full_name: string | null
          handle: string
          highlights_last_viewed_at: string | null
          home_city: string | null
          home_country: string | null
          home_country_verified_at: string | null
          host_verified_at: string | null
          id: string
          id_verified_at: string | null
          interests: string[]
          is_official: boolean
          is_private: boolean
          location_city: string | null
          location_country: string | null
          location_verified: boolean
          looking_for: string[] | null
          name: string
          notifications_inbox_viewed_at: string | null
          open_to_meet: boolean
          passport_hidden_sections: string[] | null
          passport_section_order: string[] | null
          passport_tab_order: string[] | null
          passport_visibility: string
          planning_style: string | null
          preferred_language: string | null
          preferred_message_language: string
          public_social_links: Json | null
          role: string
          safety_flags_count: number
          selfie_verified_at: string | null
          show_original_messages: boolean
          show_profile_picture_publicly: boolean
          show_telegraph_circle: boolean
          show_telegraph_dm: boolean
          show_telegraph_trip: boolean
          spoken_languages: string[] | null
          tag_permission: Database["public"]["Enums"]["tag_permission_level"]
          tagline: string | null
          translation_updated_at: string | null
          travel_group_style: string[] | null
          travel_pace: string | null
          travel_style: string | null
          travel_styles: string[] | null
          trust_label: string | null
          trust_score: number | null
          updated_at: string
          username: string | null
          username_updated_at: string | null
          verification_expires_at: string | null
          verification_level: string
          verification_method: string | null
          verification_status: string
          verified: boolean
          verified_at: string | null
          verified_since: string | null
        }
        Insert: {
          account_status?: string
          auto_translate_messages?: boolean
          availability_tags?: string[] | null
          avatar_image_height?: number | null
          avatar_image_width?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_original_language?: string | null
          buddy_verified_at?: string | null
          budget_style?: string | null
          city?: string | null
          comfort_level?: string | null
          country?: string | null
          country_code?: string | null
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_photo_url?: string | null
          created_at?: string
          current_city?: string | null
          date_of_birth?: string | null
          default_language?: string | null
          display_name?: string | null
          dob_verified?: boolean
          expo_push_token?: string | null
          featured_count?: number
          flag_emoji?: string | null
          full_name?: string | null
          handle: string
          highlights_last_viewed_at?: string | null
          home_city?: string | null
          home_country?: string | null
          home_country_verified_at?: string | null
          host_verified_at?: string | null
          id: string
          id_verified_at?: string | null
          interests?: string[]
          is_official?: boolean
          is_private?: boolean
          location_city?: string | null
          location_country?: string | null
          location_verified?: boolean
          looking_for?: string[] | null
          name: string
          notifications_inbox_viewed_at?: string | null
          open_to_meet?: boolean
          passport_hidden_sections?: string[] | null
          passport_section_order?: string[] | null
          passport_tab_order?: string[] | null
          passport_visibility?: string
          planning_style?: string | null
          preferred_language?: string | null
          preferred_message_language?: string
          public_social_links?: Json | null
          role?: string
          safety_flags_count?: number
          selfie_verified_at?: string | null
          show_original_messages?: boolean
          show_profile_picture_publicly?: boolean
          show_telegraph_circle?: boolean
          show_telegraph_dm?: boolean
          show_telegraph_trip?: boolean
          spoken_languages?: string[] | null
          tag_permission?: Database["public"]["Enums"]["tag_permission_level"]
          tagline?: string | null
          translation_updated_at?: string | null
          travel_group_style?: string[] | null
          travel_pace?: string | null
          travel_style?: string | null
          travel_styles?: string[] | null
          trust_label?: string | null
          trust_score?: number | null
          updated_at?: string
          username?: string | null
          username_updated_at?: string | null
          verification_expires_at?: string | null
          verification_level?: string
          verification_method?: string | null
          verification_status?: string
          verified?: boolean
          verified_at?: string | null
          verified_since?: string | null
        }
        Update: {
          account_status?: string
          auto_translate_messages?: boolean
          availability_tags?: string[] | null
          avatar_image_height?: number | null
          avatar_image_width?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_original_language?: string | null
          buddy_verified_at?: string | null
          budget_style?: string | null
          city?: string | null
          comfort_level?: string | null
          country?: string | null
          country_code?: string | null
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_photo_url?: string | null
          created_at?: string
          current_city?: string | null
          date_of_birth?: string | null
          default_language?: string | null
          display_name?: string | null
          dob_verified?: boolean
          expo_push_token?: string | null
          featured_count?: number
          flag_emoji?: string | null
          full_name?: string | null
          handle?: string
          highlights_last_viewed_at?: string | null
          home_city?: string | null
          home_country?: string | null
          home_country_verified_at?: string | null
          host_verified_at?: string | null
          id?: string
          id_verified_at?: string | null
          interests?: string[]
          is_official?: boolean
          is_private?: boolean
          location_city?: string | null
          location_country?: string | null
          location_verified?: boolean
          looking_for?: string[] | null
          name?: string
          notifications_inbox_viewed_at?: string | null
          open_to_meet?: boolean
          passport_hidden_sections?: string[] | null
          passport_section_order?: string[] | null
          passport_tab_order?: string[] | null
          passport_visibility?: string
          planning_style?: string | null
          preferred_language?: string | null
          preferred_message_language?: string
          public_social_links?: Json | null
          role?: string
          safety_flags_count?: number
          selfie_verified_at?: string | null
          show_original_messages?: boolean
          show_profile_picture_publicly?: boolean
          show_telegraph_circle?: boolean
          show_telegraph_dm?: boolean
          show_telegraph_trip?: boolean
          spoken_languages?: string[] | null
          tag_permission?: Database["public"]["Enums"]["tag_permission_level"]
          tagline?: string | null
          translation_updated_at?: string | null
          travel_group_style?: string[] | null
          travel_pace?: string | null
          travel_style?: string | null
          travel_styles?: string[] | null
          trust_label?: string | null
          trust_score?: number | null
          updated_at?: string
          username?: string | null
          username_updated_at?: string | null
          verification_expires_at?: string | null
          verification_level?: string
          verification_method?: string | null
          verification_status?: string
          verified?: boolean
          verified_at?: string | null
          verified_since?: string | null
        }
        Relationships: []
      }
      pulse_geo_tags: {
        Row: {
          approx_distance_label: string | null
          city: string | null
          confidence_score: number | null
          country: string | null
          country_code: string | null
          created_at: string
          display_label: string | null
          district: string | null
          geo_zone_id: string | null
          hotel_blur_applied: boolean
          id: string
          location_visibility: string
          post_id: string
          source: Database["public"]["Enums"]["pulse_geo_source"]
          tag_type: Database["public"]["Enums"]["pulse_geo_tag_type"] | null
          user_id: string | null
          venue_name: string | null
        }
        Insert: {
          approx_distance_label?: string | null
          city?: string | null
          confidence_score?: number | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          display_label?: string | null
          district?: string | null
          geo_zone_id?: string | null
          hotel_blur_applied?: boolean
          id?: string
          location_visibility?: string
          post_id: string
          source?: Database["public"]["Enums"]["pulse_geo_source"]
          tag_type?: Database["public"]["Enums"]["pulse_geo_tag_type"] | null
          user_id?: string | null
          venue_name?: string | null
        }
        Update: {
          approx_distance_label?: string | null
          city?: string | null
          confidence_score?: number | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          display_label?: string | null
          district?: string | null
          geo_zone_id?: string | null
          hotel_blur_applied?: boolean
          id?: string
          location_visibility?: string
          post_id?: string
          source?: Database["public"]["Enums"]["pulse_geo_source"]
          tag_type?: Database["public"]["Enums"]["pulse_geo_tag_type"] | null
          user_id?: string | null
          venue_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pulse_geo_tags_geo_zone_id_fkey"
            columns: ["geo_zone_id"]
            isOneToOne: false
            referencedRelation: "geo_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_geo_tags_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      push_retry_queue: {
        Row: {
          attempt_count: number
          created_at: string
          delivery_attempt_id: string | null
          id: string
          last_error: string | null
          max_attempts: number
          next_retry_at: string
          notification_id: string | null
          payload: Json
          status: string
          tokens: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          delivery_attempt_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_retry_at?: string
          notification_id?: string | null
          payload?: Json
          status?: string
          tokens?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          delivery_attempt_id?: string | null
          id?: string
          last_error?: string | null
          max_attempts?: number
          next_retry_at?: string
          notification_id?: string | null
          payload?: Json
          status?: string
          tokens?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_retry_queue_delivery_attempt_id_fkey"
            columns: ["delivery_attempt_id"]
            isOneToOne: false
            referencedRelation: "notification_delivery_attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_retry_queue_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_retry_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_retry_queue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      quick_availability_status: {
        Row: {
          expires_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          expires_at: string
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          expires_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quick_availability_status_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quick_availability_status_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rank_events: {
        Row: {
          content_type: string | null
          event_type: string | null
          features: Json
          id: string
          item_id: string
          item_kind: string | null
          outcome: string
          outcome_at: string | null
          position: number | null
          served_at: string
          session_id: string | null
          surface: string
          user_id: string
        }
        Insert: {
          content_type?: string | null
          event_type?: string | null
          features?: Json
          id?: string
          item_id: string
          item_kind?: string | null
          outcome?: string
          outcome_at?: string | null
          position?: number | null
          served_at?: string
          session_id?: string | null
          surface: string
          user_id: string
        }
        Update: {
          content_type?: string | null
          event_type?: string | null
          features?: Json
          id?: string
          item_id?: string
          item_kind?: string | null
          outcome?: string
          outcome_at?: string | null
          position?: number | null
          served_at?: string
          session_id?: string | null
          surface?: string
          user_id?: string
        }
        Relationships: []
      }
      ranking_config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          value: number
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          value: number
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          value?: number
        }
        Relationships: []
      }
      ranking_config_audit_log: {
        Row: {
          changed_at: string
          changed_by_user_id: string | null
          config_key: string
          id: string
          new_value: Json | null
          old_value: Json | null
        }
        Insert: {
          changed_at?: string
          changed_by_user_id?: string | null
          config_key: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
        }
        Update: {
          changed_at?: string
          changed_by_user_id?: string | null
          config_key?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
        }
        Relationships: []
      }
      ranking_debug_samples: {
        Row: {
          components: Json
          content_id: string
          content_type: string
          explanation_key: string | null
          final_score: number
          id: number
          item_id: string | null
          ranking_version: string
          sampled_at: string
          score_components: Json
          session_id: string | null
          surface: string | null
          viewer_id: string | null
        }
        Insert: {
          components?: Json
          content_id: string
          content_type: string
          explanation_key?: string | null
          final_score: number
          id?: number
          item_id?: string | null
          ranking_version?: string
          sampled_at?: string
          score_components?: Json
          session_id?: string | null
          surface?: string | null
          viewer_id?: string | null
        }
        Update: {
          components?: Json
          content_id?: string
          content_type?: string
          explanation_key?: string | null
          final_score?: number
          id?: number
          item_id?: string | null
          ranking_version?: string
          sampled_at?: string
          score_components?: Json
          session_id?: string | null
          surface?: string | null
          viewer_id?: string | null
        }
        Relationships: []
      }
      rent_buddy_addons: {
        Row: {
          admin_approved: boolean
          buddy_id: string
          category: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          price_usd: number
          requires_admin_approval: boolean
          title: string
        }
        Insert: {
          admin_approved?: boolean
          buddy_id: string
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          price_usd: number
          requires_admin_approval?: boolean
          title: string
        }
        Update: {
          admin_approved?: boolean
          buddy_id?: string
          category?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          price_usd?: number
          requires_admin_approval?: boolean
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_addons_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_addons_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_admin_access_logs: {
        Row: {
          admin_id: string
          created_at: string
          id: string
          reason: string | null
          resource: string
          resource_id: string | null
        }
        Insert: {
          admin_id: string
          created_at?: string
          id?: string
          reason?: string | null
          resource: string
          resource_id?: string | null
        }
        Update: {
          admin_id?: string
          created_at?: string
          id?: string
          reason?: string | null
          resource?: string
          resource_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_admin_access_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_admin_access_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_admin_actions: {
        Row: {
          action: string
          admin_id: string | null
          created_at: string
          details: Json | null
          id: string
          notes: string | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          notes?: string | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          notes?: string | null
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_admin_response_templates: {
        Row: {
          body: string
          category: string
          created_at: string
          id: string
          is_active: boolean
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          category: string
          created_at?: string
          id?: string
          is_active?: boolean
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          category?: string
          created_at?: string
          id?: string
          is_active?: boolean
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      rent_buddy_applications: {
        Row: {
          admin_status: string | null
          availability_blocks: Json
          categories: string[]
          city: string
          country: string | null
          created_at: string
          id: string
          id_verification_ref: string | null
          languages: string[]
          motivation: string | null
          policy_accepted: boolean
          policy_accepted_at: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          social_links: Json
          status: Database["public"]["Enums"]["rent_buddy_application_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_status?: string | null
          availability_blocks?: Json
          categories?: string[]
          city: string
          country?: string | null
          created_at?: string
          id?: string
          id_verification_ref?: string | null
          languages?: string[]
          motivation?: string | null
          policy_accepted?: boolean
          policy_accepted_at?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          social_links?: Json
          status?: Database["public"]["Enums"]["rent_buddy_application_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_status?: string | null
          availability_blocks?: Json
          categories?: string[]
          city?: string
          country?: string | null
          created_at?: string
          id?: string
          id_verification_ref?: string | null
          languages?: string[]
          motivation?: string | null
          policy_accepted?: boolean
          policy_accepted_at?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          social_links?: Json
          status?: Database["public"]["Enums"]["rent_buddy_application_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_applications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_applications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_availability: {
        Row: {
          arrival_available: boolean
          buddy_id: string
          buffer_minutes: number
          created_at: string
          custom_available: boolean
          date: string
          group_available: boolean
          id: string
          is_available: boolean
          max_bookings_per_day: number
          min_notice_hours: number
          nightlife_available: boolean
          notes: string | null
          one_time_blocks: Json
          time_slots: string[]
          updated_at: string
          vacation_dates: Json
          weekly_blocks: Json
        }
        Insert: {
          arrival_available?: boolean
          buddy_id: string
          buffer_minutes?: number
          created_at?: string
          custom_available?: boolean
          date: string
          group_available?: boolean
          id?: string
          is_available?: boolean
          max_bookings_per_day?: number
          min_notice_hours?: number
          nightlife_available?: boolean
          notes?: string | null
          one_time_blocks?: Json
          time_slots?: string[]
          updated_at?: string
          vacation_dates?: Json
          weekly_blocks?: Json
        }
        Update: {
          arrival_available?: boolean
          buddy_id?: string
          buffer_minutes?: number
          created_at?: string
          custom_available?: boolean
          date?: string
          group_available?: boolean
          id?: string
          is_available?: boolean
          max_bookings_per_day?: number
          min_notice_hours?: number
          nightlife_available?: boolean
          notes?: string | null
          one_time_blocks?: Json
          time_slots?: string[]
          updated_at?: string
          vacation_dates?: Json
          weekly_blocks?: Json
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_availability_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_availability_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_beta_access: {
        Row: {
          access_type: Database["public"]["Enums"]["rent_buddy_beta_access_type"]
          city: string
          created_at: string
          id: string
          invited_by: string | null
          notes: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: Database["public"]["Enums"]["rent_buddy_beta_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          access_type?: Database["public"]["Enums"]["rent_buddy_beta_access_type"]
          city: string
          created_at?: string
          id?: string
          invited_by?: string | null
          notes?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_beta_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          access_type?: Database["public"]["Enums"]["rent_buddy_beta_access_type"]
          city?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          notes?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_beta_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_beta_access_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_beta_access_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_beta_access_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_beta_access_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_beta_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_beta_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_booking_addons: {
        Row: {
          addon_id: string | null
          booking_id: string
          created_at: string
          id: string
          price_usd: number
          title: string
        }
        Insert: {
          addon_id?: string | null
          booking_id: string
          created_at?: string
          id?: string
          price_usd?: number
          title: string
        }
        Update: {
          addon_id?: string | null
          booking_id?: string
          created_at?: string
          id?: string
          price_usd?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_booking_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_addons_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_addons_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_addons_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_booking_extensions: {
        Row: {
          booking_id: string
          confirmed_by_buddy: boolean | null
          confirmed_by_traveler: boolean | null
          created_at: string
          extra_hours: number
          extra_usd: number
          id: string
          payment_mode: Database["public"]["Enums"]["rent_buddy_payment_mode"]
        }
        Insert: {
          booking_id: string
          confirmed_by_buddy?: boolean | null
          confirmed_by_traveler?: boolean | null
          created_at?: string
          extra_hours: number
          extra_usd: number
          id?: string
          payment_mode?: Database["public"]["Enums"]["rent_buddy_payment_mode"]
        }
        Update: {
          booking_id?: string
          confirmed_by_buddy?: boolean | null
          confirmed_by_traveler?: boolean | null
          created_at?: string
          extra_hours?: number
          extra_usd?: number
          id?: string
          payment_mode?: Database["public"]["Enums"]["rent_buddy_payment_mode"]
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_booking_extensions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_extensions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_extensions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_bookings: {
        Row: {
          addons_total_usd: number
          booking_date: string
          buddy_id: string
          cancellation_reason: string | null
          cancelled_at: string | null
          cash_balance_confirmed_at: string | null
          cash_balance_confirmed_by_buddy: boolean | null
          cash_balance_confirmed_by_traveler: boolean | null
          cash_balance_usd: number
          category: string
          city: string
          completed_at: string | null
          confirmed_at: string | null
          country_code: string | null
          created_at: string
          decline_reason: string | null
          deposit_percent: number | null
          deposit_reason: string | null
          deposit_rule_applied: string | null
          deposit_usd: number
          dispute_reason: string | null
          dispute_window_expires_at: string | null
          duration_h: number
          expires_at: string | null
          group_lead_id: string | null
          group_size: number
          id: string
          is_group_booking: boolean
          is_test_booking: boolean
          no_show_grace_expires_at: string | null
          notes: string | null
          offer_id: string | null
          package_id: string | null
          payment_mode: Database["public"]["Enums"]["rent_buddy_payment_mode"]
          payment_status: Database["public"]["Enums"]["rent_buddy_payment_status"]
          pricing_type: string
          request_id: string | null
          route_plan: Json
          safety_status: Database["public"]["Enums"]["rent_buddy_safety_status"]
          start_time: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["rent_buddy_booking_status"]
          stay_connected_buddy: boolean
          stay_connected_traveler: boolean
          telegraph_thread_id: string | null
          tip_usd: number | null
          total_usd: number
          traveler_id: string
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          addons_total_usd?: number
          booking_date: string
          buddy_id: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cash_balance_confirmed_at?: string | null
          cash_balance_confirmed_by_buddy?: boolean | null
          cash_balance_confirmed_by_traveler?: boolean | null
          cash_balance_usd?: number
          category: string
          city: string
          completed_at?: string | null
          confirmed_at?: string | null
          country_code?: string | null
          created_at?: string
          decline_reason?: string | null
          deposit_percent?: number | null
          deposit_reason?: string | null
          deposit_rule_applied?: string | null
          deposit_usd?: number
          dispute_reason?: string | null
          dispute_window_expires_at?: string | null
          duration_h: number
          expires_at?: string | null
          group_lead_id?: string | null
          group_size?: number
          id?: string
          is_group_booking?: boolean
          is_test_booking?: boolean
          no_show_grace_expires_at?: string | null
          notes?: string | null
          offer_id?: string | null
          package_id?: string | null
          payment_mode?: Database["public"]["Enums"]["rent_buddy_payment_mode"]
          payment_status?: Database["public"]["Enums"]["rent_buddy_payment_status"]
          pricing_type?: string
          request_id?: string | null
          route_plan?: Json
          safety_status?: Database["public"]["Enums"]["rent_buddy_safety_status"]
          start_time?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_booking_status"]
          stay_connected_buddy?: boolean
          stay_connected_traveler?: boolean
          telegraph_thread_id?: string | null
          tip_usd?: number | null
          total_usd?: number
          traveler_id: string
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          addons_total_usd?: number
          booking_date?: string
          buddy_id?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cash_balance_confirmed_at?: string | null
          cash_balance_confirmed_by_buddy?: boolean | null
          cash_balance_confirmed_by_traveler?: boolean | null
          cash_balance_usd?: number
          category?: string
          city?: string
          completed_at?: string | null
          confirmed_at?: string | null
          country_code?: string | null
          created_at?: string
          decline_reason?: string | null
          deposit_percent?: number | null
          deposit_reason?: string | null
          deposit_rule_applied?: string | null
          deposit_usd?: number
          dispute_reason?: string | null
          dispute_window_expires_at?: string | null
          duration_h?: number
          expires_at?: string | null
          group_lead_id?: string | null
          group_size?: number
          id?: string
          is_group_booking?: boolean
          is_test_booking?: boolean
          no_show_grace_expires_at?: string | null
          notes?: string | null
          offer_id?: string | null
          package_id?: string | null
          payment_mode?: Database["public"]["Enums"]["rent_buddy_payment_mode"]
          payment_status?: Database["public"]["Enums"]["rent_buddy_payment_status"]
          pricing_type?: string
          request_id?: string | null
          route_plan?: Json
          safety_status?: Database["public"]["Enums"]["rent_buddy_safety_status"]
          start_time?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_booking_status"]
          stay_connected_buddy?: boolean
          stay_connected_traveler?: boolean
          telegraph_thread_id?: string | null
          tip_usd?: number | null
          total_usd?: number
          traveler_id?: string
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_group_lead_id_fkey"
            columns: ["group_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_group_lead_id_fkey"
            columns: ["group_lead_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_city_restrictions: {
        Row: {
          category: string | null
          city: string | null
          created_at: string
          created_by: string | null
          disable_deposit_cash: boolean
          id: string
          reason: string | null
          require_full_in_app: boolean
          require_public_meetup: boolean
        }
        Insert: {
          category?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          disable_deposit_cash?: boolean
          id?: string
          reason?: string | null
          require_full_in_app?: boolean
          require_public_meetup?: boolean
        }
        Update: {
          category?: string | null
          city?: string | null
          created_at?: string
          created_by?: string | null
          disable_deposit_cash?: boolean
          id?: string
          reason?: string | null
          require_full_in_app?: boolean
          require_public_meetup?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_city_restrictions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_city_restrictions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_city_rollouts: {
        Row: {
          buddy_cap: number | null
          city: string
          country: string | null
          created_at: string | null
          id: string
          notes: string | null
          status: string
          status_changed_at: string | null
          status_changed_by: string | null
          target_launch_date: string | null
          updated_at: string | null
        }
        Insert: {
          buddy_cap?: number | null
          city: string
          country?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          target_launch_date?: string | null
          updated_at?: string | null
        }
        Update: {
          buddy_cap?: number | null
          city?: string
          country?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          status?: string
          status_changed_at?: string | null
          status_changed_by?: string | null
          target_launch_date?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_city_rollouts_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_city_rollouts_status_changed_by_fkey"
            columns: ["status_changed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_disputes: {
        Row: {
          booking_id: string
          created_at: string
          id: string
          raised_by: string
          reason: Database["public"]["Enums"]["rent_buddy_dispute_reason"]
          resolution_note: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["rent_buddy_dispute_status"]
        }
        Insert: {
          booking_id: string
          created_at?: string
          id?: string
          raised_by: string
          reason: Database["public"]["Enums"]["rent_buddy_dispute_reason"]
          resolution_note?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_dispute_status"]
        }
        Update: {
          booking_id?: string
          created_at?: string
          id?: string
          raised_by?: string
          reason?: Database["public"]["Enums"]["rent_buddy_dispute_reason"]
          resolution_note?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rent_buddy_dispute_status"]
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_earnings_ledger: {
        Row: {
          addons_usd: number
          booking_id: string
          buddy_gross_amount: number
          buddy_net_estimated_amount: number
          buddy_user_id: string
          cash_balance_confirmed: boolean
          cash_balance_due: number
          created_at: string
          deposit_amount: number
          id: string
          in_app_amount_collected: number
          is_estimated: boolean
          note: string | null
          platform_fee_amount: number
          platform_fee_percent: number | null
          pricing_type: string | null
          tip_usd: number
          total_booking_usd: number
          traveler_id: string
          traveler_service_fee_amount: number
          updated_at: string
        }
        Insert: {
          addons_usd?: number
          booking_id: string
          buddy_gross_amount?: number
          buddy_net_estimated_amount?: number
          buddy_user_id: string
          cash_balance_confirmed?: boolean
          cash_balance_due?: number
          created_at?: string
          deposit_amount?: number
          id?: string
          in_app_amount_collected?: number
          is_estimated?: boolean
          note?: string | null
          platform_fee_amount?: number
          platform_fee_percent?: number | null
          pricing_type?: string | null
          tip_usd?: number
          total_booking_usd?: number
          traveler_id: string
          traveler_service_fee_amount?: number
          updated_at?: string
        }
        Update: {
          addons_usd?: number
          booking_id?: string
          buddy_gross_amount?: number
          buddy_net_estimated_amount?: number
          buddy_user_id?: string
          cash_balance_confirmed?: boolean
          cash_balance_due?: number
          created_at?: string
          deposit_amount?: number
          id?: string
          in_app_amount_collected?: number
          is_estimated?: boolean
          note?: string | null
          platform_fee_amount?: number
          platform_fee_percent?: number | null
          pricing_type?: string | null
          tip_usd?: number
          total_booking_usd?: number
          traveler_id?: string
          traveler_service_fee_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_earnings_ledger_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_earnings_ledger_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_emergency_contacts_snapshot: {
        Row: {
          booking_id: string
          created_at: string
          emergency_contact_count: number
          id: string
          safe_return_enabled: boolean
          trusted_circle_shared: boolean
          user_id: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          emergency_contact_count?: number
          id?: string
          safe_return_enabled?: boolean
          trusted_circle_shared?: boolean
          user_id: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          emergency_contact_count?: number
          id?: string
          safe_return_enabled?: boolean
          trusted_circle_shared?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_emergency_contacts_snapshot_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_emergency_contacts_snapshot_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_emergency_contacts_snapshot_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_emergency_contacts_snapshot_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_emergency_contacts_snapshot_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_fee_rules: {
        Row: {
          buddy_level: string
          id: string
          platform_fee_percent: number
          traveler_service_fee_pct: number
          traveler_service_fee_usd: number
          updated_at: string
        }
        Insert: {
          buddy_level: string
          id?: string
          platform_fee_percent: number
          traveler_service_fee_pct?: number
          traveler_service_fee_usd?: number
          updated_at?: string
        }
        Update: {
          buddy_level?: string
          id?: string
          platform_fee_percent?: number
          traveler_service_fee_pct?: number
          traveler_service_fee_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      rent_buddy_global_controls: {
        Row: {
          all_bookings_paused: boolean
          applications_paused: boolean
          cash_balance_paused: boolean
          force_delayed_posting: boolean
          force_full_in_app: boolean
          force_public_meetup: boolean
          id: number
          nightlife_paused: boolean
          updated_at: string | null
          updated_by_admin_id: string | null
        }
        Insert: {
          all_bookings_paused?: boolean
          applications_paused?: boolean
          cash_balance_paused?: boolean
          force_delayed_posting?: boolean
          force_full_in_app?: boolean
          force_public_meetup?: boolean
          id?: number
          nightlife_paused?: boolean
          updated_at?: string | null
          updated_by_admin_id?: string | null
        }
        Update: {
          all_bookings_paused?: boolean
          applications_paused?: boolean
          cash_balance_paused?: boolean
          force_delayed_posting?: boolean
          force_full_in_app?: boolean
          force_public_meetup?: boolean
          id?: number
          nightlife_paused?: boolean
          updated_at?: string | null
          updated_by_admin_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_global_controls_updated_by_admin_id_fkey"
            columns: ["updated_by_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_global_controls_updated_by_admin_id_fkey"
            columns: ["updated_by_admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_launch_audit_logs: {
        Row: {
          action: string
          admin_id: string
          city_rollout_id: string | null
          created_at: string
          from_status: string | null
          id: string
          metadata: Json
          override_reason: string | null
          to_status: string | null
        }
        Insert: {
          action: string
          admin_id: string
          city_rollout_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          metadata?: Json
          override_reason?: string | null
          to_status?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          city_rollout_id?: string | null
          created_at?: string
          from_status?: string | null
          id?: string
          metadata?: Json
          override_reason?: string | null
          to_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_launch_audit_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_launch_audit_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_launch_audit_logs_city_rollout_id_fkey"
            columns: ["city_rollout_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_city_rollouts"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_launch_checklists: {
        Row: {
          booking_flow_passed: boolean
          buddy_application_passed: boolean
          checklist_status: Database["public"]["Enums"]["rent_buddy_checklist_status"]
          city_rollout_id: string
          created_at: string
          id: string
          moderation_passed: boolean
          notes: string | null
          payment_flow_passed: boolean
          policy_scan_passed: boolean
          safety_flow_passed: boolean
          telegraph_passed: boolean
          tested_at: string | null
          tested_by_admin_id: string | null
          trust_score_passed: boolean
          updated_at: string
          waitlist_flow_passed: boolean
        }
        Insert: {
          booking_flow_passed?: boolean
          buddy_application_passed?: boolean
          checklist_status?: Database["public"]["Enums"]["rent_buddy_checklist_status"]
          city_rollout_id: string
          created_at?: string
          id?: string
          moderation_passed?: boolean
          notes?: string | null
          payment_flow_passed?: boolean
          policy_scan_passed?: boolean
          safety_flow_passed?: boolean
          telegraph_passed?: boolean
          tested_at?: string | null
          tested_by_admin_id?: string | null
          trust_score_passed?: boolean
          updated_at?: string
          waitlist_flow_passed?: boolean
        }
        Update: {
          booking_flow_passed?: boolean
          buddy_application_passed?: boolean
          checklist_status?: Database["public"]["Enums"]["rent_buddy_checklist_status"]
          city_rollout_id?: string
          created_at?: string
          id?: string
          moderation_passed?: boolean
          notes?: string | null
          payment_flow_passed?: boolean
          policy_scan_passed?: boolean
          safety_flow_passed?: boolean
          telegraph_passed?: boolean
          tested_at?: string | null
          tested_by_admin_id?: string | null
          trust_score_passed?: boolean
          updated_at?: string
          waitlist_flow_passed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_launch_checklists_city_rollout_id_fkey"
            columns: ["city_rollout_id"]
            isOneToOne: true
            referencedRelation: "rent_buddy_city_rollouts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_launch_checklists_tested_by_admin_id_fkey"
            columns: ["tested_by_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_launch_checklists_tested_by_admin_id_fkey"
            columns: ["tested_by_admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_launch_controls: {
        Row: {
          category: string | null
          city: string | null
          country_code: string | null
          created_at: string
          created_by: string | null
          enabled: boolean
          full_payment_required: boolean
          id: string
          min_age: number
          min_deposit_pct: number
          nightlife_min_age: number
          notes: string | null
          require_id_verification: boolean
          require_phone_verification: boolean
          updated_at: string
          waitlist_only: boolean
        }
        Insert: {
          category?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          full_payment_required?: boolean
          id?: string
          min_age?: number
          min_deposit_pct?: number
          nightlife_min_age?: number
          notes?: string | null
          require_id_verification?: boolean
          require_phone_verification?: boolean
          updated_at?: string
          waitlist_only?: boolean
        }
        Update: {
          category?: string | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          full_payment_required?: boolean
          id?: string
          min_age?: number
          min_deposit_pct?: number
          nightlife_min_age?: number
          notes?: string | null
          require_id_verification?: boolean
          require_phone_verification?: boolean
          updated_at?: string
          waitlist_only?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_launch_controls_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_launch_controls_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_marketplace_analytics_events: {
        Row: {
          amount_usd: number | null
          buddy_id: string | null
          category: string | null
          city: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          user_id: string | null
        }
        Insert: {
          amount_usd?: number | null
          buddy_id?: string | null
          category?: string | null
          city?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          user_id?: string | null
        }
        Update: {
          amount_usd?: number | null
          buddy_id?: string | null
          category?: string | null
          city?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_marketplace_analytics_events_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_marketplace_analytics_events_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_marketplace_analytics_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_marketplace_analytics_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_match_preferences: {
        Row: {
          booking_length: string | null
          budget_max_usd: number | null
          budget_min_usd: number | null
          created_at: string
          energy: string | null
          female_only: boolean
          group_size: number
          id: string
          language: string | null
          need: string | null
          public_only: boolean
          raw_answers: Json
          safety_prefs: Json
          updated_at: string
          user_id: string
          vibe: string | null
        }
        Insert: {
          booking_length?: string | null
          budget_max_usd?: number | null
          budget_min_usd?: number | null
          created_at?: string
          energy?: string | null
          female_only?: boolean
          group_size?: number
          id?: string
          language?: string | null
          need?: string | null
          public_only?: boolean
          raw_answers?: Json
          safety_prefs?: Json
          updated_at?: string
          user_id: string
          vibe?: string | null
        }
        Update: {
          booking_length?: string | null
          budget_max_usd?: number | null
          budget_min_usd?: number | null
          created_at?: string
          energy?: string | null
          female_only?: boolean
          group_size?: number
          id?: string
          language?: string | null
          need?: string | null
          public_only?: boolean
          raw_answers?: Json
          safety_prefs?: Json
          updated_at?: string
          user_id?: string
          vibe?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_match_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_match_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_match_scores: {
        Row: {
          buddy_id: string
          computed_at: string
          expires_at: string
          id: string
          inputs: Json
          score: number
          user_id: string
        }
        Insert: {
          buddy_id: string
          computed_at?: string
          expires_at?: string
          id?: string
          inputs?: Json
          score: number
          user_id: string
        }
        Update: {
          buddy_id?: string
          computed_at?: string
          expires_at?: string
          id?: string
          inputs?: Json
          score?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_match_scores_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_match_scores_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_match_scores_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_match_scores_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_offers: {
        Row: {
          accepted_booking_id: string | null
          addons_offered: Json
          buddy_profile_id: string
          buddy_user_id: string
          cash_balance_usd: number
          created_at: string
          deposit_amount_usd: number
          expires_at: string
          id: string
          included_services: string[]
          meetup_location: string | null
          message: string | null
          payment_mode: string
          proposed_end: string | null
          proposed_price_usd: number
          proposed_start: string | null
          request_id: string
          status: string
          updated_at: string
        }
        Insert: {
          accepted_booking_id?: string | null
          addons_offered?: Json
          buddy_profile_id: string
          buddy_user_id: string
          cash_balance_usd?: number
          created_at?: string
          deposit_amount_usd?: number
          expires_at?: string
          id?: string
          included_services?: string[]
          meetup_location?: string | null
          message?: string | null
          payment_mode?: string
          proposed_end?: string | null
          proposed_price_usd: number
          proposed_start?: string | null
          request_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          accepted_booking_id?: string | null
          addons_offered?: Json
          buddy_profile_id?: string
          buddy_user_id?: string
          cash_balance_usd?: number
          created_at?: string
          deposit_amount_usd?: number
          expires_at?: string
          id?: string
          included_services?: string[]
          meetup_location?: string | null
          message?: string | null
          payment_mode?: string
          proposed_end?: string | null
          proposed_price_usd?: number
          proposed_start?: string | null
          request_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_offers_buddy_profile_id_fkey"
            columns: ["buddy_profile_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_offers_buddy_profile_id_fkey"
            columns: ["buddy_profile_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_offers_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_offers_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_offers_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_package_stops: {
        Row: {
          created_at: string
          description: string | null
          duration_minutes: number | null
          id: string
          location_hint: string | null
          name: string
          package_id: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          location_hint?: string | null
          name: string
          package_id: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          location_hint?: string | null
          name?: string
          package_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_package_stops_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_packages"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_packages: {
        Row: {
          addon_ids: string[]
          admin_review_status: string
          admin_reviewed_at: string | null
          admin_reviewed_by: string | null
          base_price: number | null
          buddy_id: string
          category: string
          city: string | null
          created_at: string
          deposit_percent: number
          deposit_required: boolean
          description: string | null
          duration_h: number
          id: string
          included_services: string[]
          included_stops: Json
          is_active: boolean
          max_group: number
          meetup_rules: string | null
          payment_modes_allowed: string[]
          price_usd: number
          stops: Json
          title: string
          updated_at: string
        }
        Insert: {
          addon_ids?: string[]
          admin_review_status?: string
          admin_reviewed_at?: string | null
          admin_reviewed_by?: string | null
          base_price?: number | null
          buddy_id: string
          category: string
          city?: string | null
          created_at?: string
          deposit_percent?: number
          deposit_required?: boolean
          description?: string | null
          duration_h: number
          id?: string
          included_services?: string[]
          included_stops?: Json
          is_active?: boolean
          max_group?: number
          meetup_rules?: string | null
          payment_modes_allowed?: string[]
          price_usd: number
          stops?: Json
          title: string
          updated_at?: string
        }
        Update: {
          addon_ids?: string[]
          admin_review_status?: string
          admin_reviewed_at?: string | null
          admin_reviewed_by?: string | null
          base_price?: number | null
          buddy_id?: string
          category?: string
          city?: string | null
          created_at?: string
          deposit_percent?: number
          deposit_required?: boolean
          description?: string | null
          duration_h?: number
          id?: string
          included_services?: string[]
          included_stops?: Json
          is_active?: boolean
          max_group?: number
          meetup_rules?: string | null
          payment_modes_allowed?: string[]
          price_usd?: number
          stops?: Json
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_packages_admin_reviewed_by_fkey"
            columns: ["admin_reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_packages_admin_reviewed_by_fkey"
            columns: ["admin_reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_packages_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_packages_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_payouts: {
        Row: {
          amount_usd: number
          booking_id: string
          buddy_id: string
          created_at: string
          held_at: string | null
          held_by: string | null
          hold_reason: string | null
          id: string
          notes: string | null
          released_at: string | null
          released_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_usd?: number
          booking_id: string
          buddy_id: string
          created_at?: string
          held_at?: string | null
          held_by?: string | null
          hold_reason?: string | null
          id?: string
          notes?: string | null
          released_at?: string | null
          released_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount_usd?: number
          booking_id?: string
          buddy_id?: string
          created_at?: string
          held_at?: string | null
          held_by?: string | null
          hold_reason?: string | null
          id?: string
          notes?: string | null
          released_at?: string | null
          released_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_payouts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_held_by_fkey"
            columns: ["held_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_held_by_fkey"
            columns: ["held_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_released_by_fkey"
            columns: ["released_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_payouts_released_by_fkey"
            columns: ["released_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_policy_flags: {
        Row: {
          admin_notes: string | null
          booking_id: string | null
          category: string
          created_at: string
          flagged_user_id: string | null
          id: string
          matched_text_excerpt: string | null
          reporter_user_id: string | null
          resolved_at: string | null
          severity: Database["public"]["Enums"]["rent_buddy_flag_severity"]
          source_id: string | null
          source_type: Database["public"]["Enums"]["rent_buddy_flag_source"]
          status: Database["public"]["Enums"]["rent_buddy_flag_status"]
          updated_at: string
        }
        Insert: {
          admin_notes?: string | null
          booking_id?: string | null
          category: string
          created_at?: string
          flagged_user_id?: string | null
          id?: string
          matched_text_excerpt?: string | null
          reporter_user_id?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["rent_buddy_flag_severity"]
          source_id?: string | null
          source_type: Database["public"]["Enums"]["rent_buddy_flag_source"]
          status?: Database["public"]["Enums"]["rent_buddy_flag_status"]
          updated_at?: string
        }
        Update: {
          admin_notes?: string | null
          booking_id?: string | null
          category?: string
          created_at?: string
          flagged_user_id?: string | null
          id?: string
          matched_text_excerpt?: string | null
          reporter_user_id?: string | null
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["rent_buddy_flag_severity"]
          source_id?: string | null
          source_type?: Database["public"]["Enums"]["rent_buddy_flag_source"]
          status?: Database["public"]["Enums"]["rent_buddy_flag_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_policy_flags_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_flagged_user_id_fkey"
            columns: ["flagged_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_flagged_user_id_fkey"
            columns: ["flagged_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_reporter_user_id_fkey"
            columns: ["reporter_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_policy_flags_reporter_user_id_fkey"
            columns: ["reporter_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_pricing_rules: {
        Row: {
          active: boolean
          buddy_level: string | null
          category: string | null
          city: string | null
          created_at: string
          id: string
          notes: string | null
          pricing_type: string
          suggested_max_usd: number
          suggested_min_usd: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          buddy_level?: string | null
          category?: string | null
          city?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          pricing_type?: string
          suggested_max_usd: number
          suggested_min_usd: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          buddy_level?: string | null
          category?: string | null
          city?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          pricing_type?: string
          suggested_max_usd?: number
          suggested_min_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      rent_buddy_profiles: {
        Row: {
          admin_status: string
          age_verified: boolean
          arrival_approved: boolean
          arrival_rate_usd: number | null
          availability_blocks: Json
          available_now: boolean
          available_now_until: string | null
          average_rating: number | null
          bio: string | null
          boundaries_acknowledged_at: string | null
          buddy_level: string
          buffer_minutes: number | null
          cancel_count: number
          cash_balance_accepted: boolean
          categories: string[]
          category_approvals: Json
          city: string
          city_ambassador: boolean
          city_ambassador_at: string | null
          city_ranking: number | null
          completed_bookings: number
          completed_count: number
          country: string | null
          cover_photo_url: string | null
          created_at: string
          date_of_birth: string | null
          deposit_percent: number
          disable_deposit_cash: boolean
          display_name: string | null
          energy_type: string | null
          expo_push_token: string | null
          favorites_count: number
          featured: boolean
          featured_at: string | null
          female_only_service: boolean
          full_day_rate_usd: number | null
          gallery_urls: string[]
          group_approved: boolean
          half_day_rate_usd: number | null
          hourly_rate_usd: number | null
          id: string
          id_verified: boolean
          intro_video_url: string | null
          languages: string[]
          max_bookings_per_day: number | null
          max_group_size: number
          meetup_base_lat: number | null
          meetup_base_lng: number | null
          min_notice_hours: number | null
          new_buddy_daytime_only: boolean
          new_buddy_max_hours: number
          new_buddy_public_only: boolean
          nightlife_admin_approved: boolean
          nightlife_approved: boolean
          nightlife_rate_usd: number | null
          no_show_count: number
          phone_verified: boolean
          policy_accepted: boolean
          preferred_meetup_zones: string[]
          profile_views: number
          public_meetup_only: boolean
          repeat_client_count: number
          response_time_h: number | null
          review_count: number
          risk_hold: boolean
          risk_review_note: string | null
          risk_review_status: Database["public"]["Enums"]["rent_buddy_risk_status"]
          risk_reviewed_at: string | null
          safety_acknowledged_at: string | null
          safety_badges: string[]
          search_appearances: number
          status: Database["public"]["Enums"]["rent_buddy_status"]
          tagline: string | null
          training_completed: boolean
          trust_score_override: number | null
          updated_at: string
          user_id: string
          verification_status: Database["public"]["Enums"]["rent_buddy_verification_status"]
          verified: boolean
          verified_at: string | null
          vibe_tags: string[]
        }
        Insert: {
          admin_status?: string
          age_verified?: boolean
          arrival_approved?: boolean
          arrival_rate_usd?: number | null
          availability_blocks?: Json
          available_now?: boolean
          available_now_until?: string | null
          average_rating?: number | null
          bio?: string | null
          boundaries_acknowledged_at?: string | null
          buddy_level?: string
          buffer_minutes?: number | null
          cancel_count?: number
          cash_balance_accepted?: boolean
          categories?: string[]
          category_approvals?: Json
          city: string
          city_ambassador?: boolean
          city_ambassador_at?: string | null
          city_ranking?: number | null
          completed_bookings?: number
          completed_count?: number
          country?: string | null
          cover_photo_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          deposit_percent?: number
          disable_deposit_cash?: boolean
          display_name?: string | null
          energy_type?: string | null
          expo_push_token?: string | null
          favorites_count?: number
          featured?: boolean
          featured_at?: string | null
          female_only_service?: boolean
          full_day_rate_usd?: number | null
          gallery_urls?: string[]
          group_approved?: boolean
          half_day_rate_usd?: number | null
          hourly_rate_usd?: number | null
          id?: string
          id_verified?: boolean
          intro_video_url?: string | null
          languages?: string[]
          max_bookings_per_day?: number | null
          max_group_size?: number
          meetup_base_lat?: number | null
          meetup_base_lng?: number | null
          min_notice_hours?: number | null
          new_buddy_daytime_only?: boolean
          new_buddy_max_hours?: number
          new_buddy_public_only?: boolean
          nightlife_admin_approved?: boolean
          nightlife_approved?: boolean
          nightlife_rate_usd?: number | null
          no_show_count?: number
          phone_verified?: boolean
          policy_accepted?: boolean
          preferred_meetup_zones?: string[]
          profile_views?: number
          public_meetup_only?: boolean
          repeat_client_count?: number
          response_time_h?: number | null
          review_count?: number
          risk_hold?: boolean
          risk_review_note?: string | null
          risk_review_status?: Database["public"]["Enums"]["rent_buddy_risk_status"]
          risk_reviewed_at?: string | null
          safety_acknowledged_at?: string | null
          safety_badges?: string[]
          search_appearances?: number
          status?: Database["public"]["Enums"]["rent_buddy_status"]
          tagline?: string | null
          training_completed?: boolean
          trust_score_override?: number | null
          updated_at?: string
          user_id: string
          verification_status?: Database["public"]["Enums"]["rent_buddy_verification_status"]
          verified?: boolean
          verified_at?: string | null
          vibe_tags?: string[]
        }
        Update: {
          admin_status?: string
          age_verified?: boolean
          arrival_approved?: boolean
          arrival_rate_usd?: number | null
          availability_blocks?: Json
          available_now?: boolean
          available_now_until?: string | null
          average_rating?: number | null
          bio?: string | null
          boundaries_acknowledged_at?: string | null
          buddy_level?: string
          buffer_minutes?: number | null
          cancel_count?: number
          cash_balance_accepted?: boolean
          categories?: string[]
          category_approvals?: Json
          city?: string
          city_ambassador?: boolean
          city_ambassador_at?: string | null
          city_ranking?: number | null
          completed_bookings?: number
          completed_count?: number
          country?: string | null
          cover_photo_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          deposit_percent?: number
          disable_deposit_cash?: boolean
          display_name?: string | null
          energy_type?: string | null
          expo_push_token?: string | null
          favorites_count?: number
          featured?: boolean
          featured_at?: string | null
          female_only_service?: boolean
          full_day_rate_usd?: number | null
          gallery_urls?: string[]
          group_approved?: boolean
          half_day_rate_usd?: number | null
          hourly_rate_usd?: number | null
          id?: string
          id_verified?: boolean
          intro_video_url?: string | null
          languages?: string[]
          max_bookings_per_day?: number | null
          max_group_size?: number
          meetup_base_lat?: number | null
          meetup_base_lng?: number | null
          min_notice_hours?: number | null
          new_buddy_daytime_only?: boolean
          new_buddy_max_hours?: number
          new_buddy_public_only?: boolean
          nightlife_admin_approved?: boolean
          nightlife_approved?: boolean
          nightlife_rate_usd?: number | null
          no_show_count?: number
          phone_verified?: boolean
          policy_accepted?: boolean
          preferred_meetup_zones?: string[]
          profile_views?: number
          public_meetup_only?: boolean
          repeat_client_count?: number
          response_time_h?: number | null
          review_count?: number
          risk_hold?: boolean
          risk_review_note?: string | null
          risk_review_status?: Database["public"]["Enums"]["rent_buddy_risk_status"]
          risk_reviewed_at?: string | null
          safety_acknowledged_at?: string | null
          safety_badges?: string[]
          search_appearances?: number
          status?: Database["public"]["Enums"]["rent_buddy_status"]
          tagline?: string | null
          training_completed?: boolean
          trust_score_override?: number | null
          updated_at?: string
          user_id?: string
          verification_status?: Database["public"]["Enums"]["rent_buddy_verification_status"]
          verified?: boolean
          verified_at?: string | null
          vibe_tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_requests: {
        Row: {
          budget_max_usd: number | null
          budget_min_usd: number | null
          category: string
          city: string
          created_at: string
          desired_date: string | null
          desired_time: string | null
          duration_minutes: number
          energy_type: string | null
          expires_at: string
          group_size: number
          id: string
          language_needed: string | null
          lat: number | null
          lng: number | null
          notes: string | null
          notified_buddy_ids: string[]
          payment_mode_pref: string | null
          policy_flag: boolean
          policy_flag_reason: string | null
          safety_prefs: Json
          status: string
          traveler_id: string
          updated_at: string
        }
        Insert: {
          budget_max_usd?: number | null
          budget_min_usd?: number | null
          category: string
          city: string
          created_at?: string
          desired_date?: string | null
          desired_time?: string | null
          duration_minutes?: number
          energy_type?: string | null
          expires_at?: string
          group_size?: number
          id?: string
          language_needed?: string | null
          lat?: number | null
          lng?: number | null
          notes?: string | null
          notified_buddy_ids?: string[]
          payment_mode_pref?: string | null
          policy_flag?: boolean
          policy_flag_reason?: string | null
          safety_prefs?: Json
          status?: string
          traveler_id: string
          updated_at?: string
        }
        Update: {
          budget_max_usd?: number | null
          budget_min_usd?: number | null
          category?: string
          city?: string
          created_at?: string
          desired_date?: string | null
          desired_time?: string | null
          duration_minutes?: number
          energy_type?: string | null
          expires_at?: string
          group_size?: number
          id?: string
          language_needed?: string | null
          lat?: number | null
          lng?: number | null
          notes?: string | null
          notified_buddy_ids?: string[]
          payment_mode_pref?: string | null
          policy_flag?: boolean
          policy_flag_reason?: string | null
          safety_prefs?: Json
          status?: string
          traveler_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_requests_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_requests_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_review_notes: {
        Row: {
          author_id: string
          booking_id: string
          created_at: string
          id: string
          note: string
          review_id: string | null
        }
        Insert: {
          author_id: string
          booking_id: string
          created_at?: string
          id?: string
          note: string
          review_id?: string | null
        }
        Update: {
          author_id?: string
          booking_id?: string
          created_at?: string
          id?: string
          note?: string
          review_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_review_notes_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "buddy_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_review_notes_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_reviews: {
        Row: {
          blind_until: string | null
          body: string | null
          booking_id: string
          category_ratings: Json | null
          communication_score: number | null
          created_at: string
          id: string
          is_public: boolean
          moderation_status: string
          photos: string[]
          private_admin_note: string | null
          punctuality_score: number | null
          rating: number
          reviewee_id: string
          reviewer_id: string
          role: string
          safety_score: number | null
          updated_at: string
        }
        Insert: {
          blind_until?: string | null
          body?: string | null
          booking_id: string
          category_ratings?: Json | null
          communication_score?: number | null
          created_at?: string
          id?: string
          is_public?: boolean
          moderation_status?: string
          photos?: string[]
          private_admin_note?: string | null
          punctuality_score?: number | null
          rating: number
          reviewee_id: string
          reviewer_id: string
          role: string
          safety_score?: number | null
          updated_at?: string
        }
        Update: {
          blind_until?: string | null
          body?: string | null
          booking_id?: string
          category_ratings?: Json | null
          communication_score?: number | null
          created_at?: string
          id?: string
          is_public?: boolean
          moderation_status?: string
          photos?: string[]
          private_admin_note?: string | null
          punctuality_score?: number | null
          rating?: number
          reviewee_id?: string
          reviewer_id?: string
          role?: string
          safety_score?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewee_id_fkey"
            columns: ["reviewee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewee_id_fkey"
            columns: ["reviewee_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_route_change_requests: {
        Row: {
          booking_id: string
          created_at: string
          id: string
          new_stops_json: Json
          old_stops_json: Json
          reason: string | null
          requested_by: string
          responded_at: string | null
          traveler_response: string | null
        }
        Insert: {
          booking_id: string
          created_at?: string
          id?: string
          new_stops_json?: Json
          old_stops_json?: Json
          reason?: string | null
          requested_by: string
          responded_at?: string | null
          traveler_response?: string | null
        }
        Update: {
          booking_id?: string
          created_at?: string
          id?: string
          new_stops_json?: Json
          old_stops_json?: Json
          reason?: string | null
          requested_by?: string
          responded_at?: string | null
          traveler_response?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_route_stops: {
        Row: {
          booking_id: string
          created_at: string
          eta: string | null
          id: string
          lat: number | null
          lng: number | null
          name: string
          notes: string | null
          stop_order: number
        }
        Insert: {
          booking_id: string
          created_at?: string
          eta?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
          notes?: string | null
          stop_order: number
        }
        Update: {
          booking_id?: string
          created_at?: string
          eta?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
          notes?: string | null
          stop_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_route_stops_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_stops_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_stops_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_safety_checkins: {
        Row: {
          booking_id: string
          checkin_type: Database["public"]["Enums"]["rent_buddy_checkin_type"]
          created_at: string
          id: string
          response: string | null
          user_id: string
        }
        Insert: {
          booking_id: string
          checkin_type: Database["public"]["Enums"]["rent_buddy_checkin_type"]
          created_at?: string
          id?: string
          response?: string | null
          user_id: string
        }
        Update: {
          booking_id?: string
          checkin_type?: Database["public"]["Enums"]["rent_buddy_checkin_type"]
          created_at?: string
          id?: string
          response?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_safety_events: {
        Row: {
          actor_user_id: string
          admin_notes: string | null
          booking_id: string | null
          created_at: string
          event_status: Database["public"]["Enums"]["rent_buddy_safety_event_status"]
          event_type: Database["public"]["Enums"]["rent_buddy_safety_event_type"]
          id: string
          metadata: Json
          target_user_id: string | null
        }
        Insert: {
          actor_user_id: string
          admin_notes?: string | null
          booking_id?: string | null
          created_at?: string
          event_status?: Database["public"]["Enums"]["rent_buddy_safety_event_status"]
          event_type: Database["public"]["Enums"]["rent_buddy_safety_event_type"]
          id?: string
          metadata?: Json
          target_user_id?: string | null
        }
        Update: {
          actor_user_id?: string
          admin_notes?: string | null
          booking_id?: string | null
          created_at?: string
          event_status?: Database["public"]["Enums"]["rent_buddy_safety_event_status"]
          event_type?: Database["public"]["Enums"]["rent_buddy_safety_event_type"]
          id?: string
          metadata?: Json
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_safety_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_saved: {
        Row: {
          buddy_id: string
          created_at: string
          notes: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          buddy_id: string
          created_at?: string
          notes?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          buddy_id?: string
          created_at?: string
          notes?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_saved_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_search_events: {
        Row: {
          category: string | null
          city: string | null
          created_at: string
          filters: Json
          id: string
          result_count: number
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          category?: string | null
          city?: string | null
          created_at?: string
          filters?: Json
          id?: string
          result_count?: number
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          category?: string | null
          city?: string | null
          created_at?: string
          filters?: Json
          id?: string
          result_count?: number
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_search_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_search_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_support_reports: {
        Row: {
          admin_notes: string | null
          booking_id: string
          category: Database["public"]["Enums"]["rb_support_category"]
          created_at: string
          details: string | null
          id: string
          reporter_id: string
          resolved_at: string | null
          status: Database["public"]["Enums"]["rb_support_status"]
          template_id: string | null
          updated_at: string
        }
        Insert: {
          admin_notes?: string | null
          booking_id: string
          category: Database["public"]["Enums"]["rb_support_category"]
          created_at?: string
          details?: string | null
          id?: string
          reporter_id: string
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rb_support_status"]
          template_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_notes?: string | null
          booking_id?: string
          category?: Database["public"]["Enums"]["rb_support_category"]
          created_at?: string
          details?: string | null
          id?: string
          reporter_id?: string
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rb_support_status"]
          template_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_support_reports_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_support_reports_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_support_reports_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_support_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_support_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_tag_consents: {
        Row: {
          booking_id: string
          consent_status: Database["public"]["Enums"]["rb_tag_consent_status"]
          created_at: string
          decline_reason: string | null
          id: string
          post_id: string | null
          requester_id: string
          resolved_at: string | null
          target_id: string
        }
        Insert: {
          booking_id: string
          consent_status?: Database["public"]["Enums"]["rb_tag_consent_status"]
          created_at?: string
          decline_reason?: string | null
          id?: string
          post_id?: string | null
          requester_id: string
          resolved_at?: string | null
          target_id: string
        }
        Update: {
          booking_id?: string
          consent_status?: Database["public"]["Enums"]["rb_tag_consent_status"]
          created_at?: string
          decline_reason?: string | null
          id?: string
          post_id?: string | null
          requester_id?: string
          resolved_at?: string | null
          target_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_tag_consents_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tag_consents_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_tips: {
        Row: {
          amount_usd: number
          booking_id: string
          buddy_user_id: string
          created_at: string
          id: string
          note: string | null
          traveler_id: string
        }
        Insert: {
          amount_usd: number
          booking_id: string
          buddy_user_id: string
          created_at?: string
          id?: string
          note?: string | null
          traveler_id: string
        }
        Update: {
          amount_usd?: number
          booking_id?: string
          buddy_user_id?: string
          created_at?: string
          id?: string
          note?: string | null
          traveler_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_tips_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: true
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_buddy_user_id_fkey"
            columns: ["buddy_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_tips_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_training_checklist: {
        Row: {
          application_id: string
          completed: boolean
          completed_at: string | null
          created_at: string
          id: string
          item_key: string
          user_id: string
        }
        Insert: {
          application_id: string
          completed?: boolean
          completed_at?: string | null
          created_at?: string
          id?: string
          item_key: string
          user_id: string
        }
        Update: {
          application_id?: string
          completed?: boolean
          completed_at?: string | null
          created_at?: string
          id?: string
          item_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_training_checklist_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_training_checklist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_training_checklist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_user_limits: {
        Row: {
          buddy_disabled: boolean
          cash_balance_disabled: boolean
          created_at: string
          created_by_admin_id: string | null
          full_in_app_payment_required: boolean
          id: string
          max_booking_duration_minutes: number | null
          nightlife_disabled: boolean
          public_meetup_required: boolean
          reason: string | null
          rent_buddy_disabled: boolean
          traveler_booking_disabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          buddy_disabled?: boolean
          cash_balance_disabled?: boolean
          created_at?: string
          created_by_admin_id?: string | null
          full_in_app_payment_required?: boolean
          id?: string
          max_booking_duration_minutes?: number | null
          nightlife_disabled?: boolean
          public_meetup_required?: boolean
          reason?: string | null
          rent_buddy_disabled?: boolean
          traveler_booking_disabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          buddy_disabled?: boolean
          cash_balance_disabled?: boolean
          created_at?: string
          created_by_admin_id?: string | null
          full_in_app_payment_required?: boolean
          id?: string
          max_booking_duration_minutes?: number | null
          nightlife_disabled?: boolean
          public_meetup_required?: boolean
          reason?: string | null
          rent_buddy_disabled?: boolean
          traveler_booking_disabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_user_limits_created_by_admin_id_fkey"
            columns: ["created_by_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_user_limits_created_by_admin_id_fkey"
            columns: ["created_by_admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_user_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_user_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      rent_buddy_waitlist: {
        Row: {
          budget_max_usd: number | null
          budget_usd: number | null
          category: string | null
          city: string
          created_at: string
          desired_date: string | null
          desired_time: string | null
          expires_at: string | null
          group_size: number
          id: string
          language: string | null
          lat: number | null
          lng: number | null
          notes: string | null
          notified_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          budget_max_usd?: number | null
          budget_usd?: number | null
          category?: string | null
          city: string
          created_at?: string
          desired_date?: string | null
          desired_time?: string | null
          expires_at?: string | null
          group_size?: number
          id?: string
          language?: string | null
          lat?: number | null
          lng?: number | null
          notes?: string | null
          notified_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          budget_max_usd?: number | null
          budget_usd?: number | null
          category?: string | null
          city?: string
          created_at?: string
          desired_date?: string | null
          desired_time?: string | null
          expires_at?: string | null
          group_size?: number
          id?: string
          language?: string | null
          lat?: number | null
          lng?: number | null
          notes?: string | null
          notified_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_waitlist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_waitlist_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      report_evidence: {
        Row: {
          content_ref: string | null
          created_at: string
          evidence_type: string
          id: string
          metadata: Json
          report_id: string
        }
        Insert: {
          content_ref?: string | null
          created_at?: string
          evidence_type: string
          id?: string
          metadata?: Json
          report_id: string
        }
        Update: {
          content_ref?: string | null
          created_at?: string
          evidence_type?: string
          id?: string
          metadata?: Json
          report_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_evidence_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "reports"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          context_id: string | null
          context_type: string | null
          created_at: string
          id: string
          moderation_notes: string | null
          notes: string | null
          reason_code: string
          reason_detail: string | null
          reporter_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          status: string
          target_id: string
          target_type: string
          updated_at: string
        }
        Insert: {
          context_id?: string | null
          context_type?: string | null
          created_at?: string
          id?: string
          moderation_notes?: string | null
          notes?: string | null
          reason_code: string
          reason_detail?: string | null
          reporter_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
          target_id: string
          target_type: string
          updated_at?: string
        }
        Update: {
          context_id?: string | null
          context_type?: string | null
          created_at?: string
          id?: string
          moderation_notes?: string | null
          notes?: string | null
          reason_code?: string
          reason_detail?: string | null
          reporter_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
          target_id?: string
          target_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      reviews: {
        Row: {
          body: string | null
          created_at: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["review_entity_type"]
          id: string
          photos: string[]
          rating: number
          reported_by: string[]
          reviewer_id: string
          state: Database["public"]["Enums"]["review_state"]
          tags: string[]
          updated_at: string
          visibility: Database["public"]["Enums"]["review_visibility"]
        }
        Insert: {
          body?: string | null
          created_at?: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["review_entity_type"]
          id?: string
          photos?: string[]
          rating: number
          reported_by?: string[]
          reviewer_id: string
          state?: Database["public"]["Enums"]["review_state"]
          tags?: string[]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["review_visibility"]
        }
        Update: {
          body?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["review_entity_type"]
          id?: string
          photos?: string[]
          rating?: number
          reported_by?: string[]
          reviewer_id?: string
          state?: Database["public"]["Enums"]["review_state"]
          tags?: string[]
          updated_at?: string
          visibility?: Database["public"]["Enums"]["review_visibility"]
        }
        Relationships: []
      }
      route_legs: {
        Row: {
          created_at: string
          distance_meters: number
          duration_seconds: number
          from_stop_id: string
          id: string
          is_approximated: boolean
          mode: Database["public"]["Enums"]["transport_mode"]
          polyline: string | null
          provider: string | null
          route_plan_id: string
          safety_notes: string | null
          to_stop_id: string
        }
        Insert: {
          created_at?: string
          distance_meters?: number
          duration_seconds?: number
          from_stop_id: string
          id?: string
          is_approximated?: boolean
          mode?: Database["public"]["Enums"]["transport_mode"]
          polyline?: string | null
          provider?: string | null
          route_plan_id: string
          safety_notes?: string | null
          to_stop_id: string
        }
        Update: {
          created_at?: string
          distance_meters?: number
          duration_seconds?: number
          from_stop_id?: string
          id?: string
          is_approximated?: boolean
          mode?: Database["public"]["Enums"]["transport_mode"]
          polyline?: string | null
          provider?: string | null
          route_plan_id?: string
          safety_notes?: string | null
          to_stop_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_legs_from_stop_id_fkey"
            columns: ["from_stop_id"]
            isOneToOne: false
            referencedRelation: "route_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "route_legs_route_plan_id_fkey"
            columns: ["route_plan_id"]
            isOneToOne: false
            referencedRelation: "route_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "route_legs_to_stop_id_fkey"
            columns: ["to_stop_id"]
            isOneToOne: false
            referencedRelation: "route_stops"
            referencedColumns: ["id"]
          },
        ]
      }
      route_plan_members: {
        Row: {
          id: string
          joined_at: string
          route_plan_id: string
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          route_plan_id: string
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          route_plan_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_plan_members_route_plan_id_fkey"
            columns: ["route_plan_id"]
            isOneToOne: false
            referencedRelation: "route_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      route_plans: {
        Row: {
          circle_id: string | null
          compass_explanation: string | null
          created_at: string
          end_location: Json | null
          id: string
          is_approximated: boolean
          owner_user_id: string
          route_style: Database["public"]["Enums"]["route_style"]
          start_location: Json | null
          status: Database["public"]["Enums"]["route_plan_status"]
          title: string
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          circle_id?: string | null
          compass_explanation?: string | null
          created_at?: string
          end_location?: Json | null
          id?: string
          is_approximated?: boolean
          owner_user_id: string
          route_style?: Database["public"]["Enums"]["route_style"]
          start_location?: Json | null
          status?: Database["public"]["Enums"]["route_plan_status"]
          title?: string
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          circle_id?: string | null
          compass_explanation?: string | null
          created_at?: string
          end_location?: Json | null
          id?: string
          is_approximated?: boolean
          owner_user_id?: string
          route_style?: Database["public"]["Enums"]["route_style"]
          start_location?: Json | null
          status?: Database["public"]["Enums"]["route_plan_status"]
          title?: string
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_plans_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "circles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "route_plans_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      route_stops: {
        Row: {
          arrived_at: string | null
          checkpoint_status: Database["public"]["Enums"]["checkpoint_status"]
          created_at: string
          id: string
          notes: string | null
          order_index: number
          planned_arrival_time: string | null
          planned_departure_time: string | null
          route_plan_id: string
          source_id: string | null
          source_type: Database["public"]["Enums"]["stop_source_type"]
          structured_location: Json
          title: string
          updated_at: string
        }
        Insert: {
          arrived_at?: string | null
          checkpoint_status?: Database["public"]["Enums"]["checkpoint_status"]
          created_at?: string
          id?: string
          notes?: string | null
          order_index?: number
          planned_arrival_time?: string | null
          planned_departure_time?: string | null
          route_plan_id: string
          source_id?: string | null
          source_type?: Database["public"]["Enums"]["stop_source_type"]
          structured_location?: Json
          title: string
          updated_at?: string
        }
        Update: {
          arrived_at?: string | null
          checkpoint_status?: Database["public"]["Enums"]["checkpoint_status"]
          created_at?: string
          id?: string
          notes?: string | null
          order_index?: number
          planned_arrival_time?: string | null
          planned_departure_time?: string | null
          route_plan_id?: string
          source_id?: string | null
          source_type?: Database["public"]["Enums"]["stop_source_type"]
          structured_location?: Json
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "route_stops_route_plan_id_fkey"
            columns: ["route_plan_id"]
            isOneToOne: false
            referencedRelation: "route_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      safe_return_contacts: {
        Row: {
          acknowledged_at: string | null
          can_receive_live_location: boolean
          contact_email: string | null
          contact_method: string
          contact_name: string | null
          contact_phone: string | null
          contact_user_id: string | null
          created_at: string
          id: string
          notified_at: string | null
          session_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          can_receive_live_location?: boolean
          contact_email?: string | null
          contact_method?: string
          contact_name?: string | null
          contact_phone?: string | null
          contact_user_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          session_id: string
        }
        Update: {
          acknowledged_at?: string | null
          can_receive_live_location?: boolean
          contact_email?: string | null
          contact_method?: string
          contact_name?: string | null
          contact_phone?: string | null
          contact_user_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "safe_return_contacts_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "safe_return_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      safe_return_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          session_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          session_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "safe_return_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "safe_return_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      safe_return_live_shares: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          last_location_snapshot_id: string | null
          recipient_contact_id: string | null
          recipient_user_id: string | null
          session_id: string
          started_at: string
          status: string
          stopped_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_location_snapshot_id?: string | null
          recipient_contact_id?: string | null
          recipient_user_id?: string | null
          session_id: string
          started_at?: string
          status?: string
          stopped_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_location_snapshot_id?: string | null
          recipient_contact_id?: string | null
          recipient_user_id?: string | null
          session_id?: string
          started_at?: string
          status?: string
          stopped_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "safe_return_live_shares_recipient_contact_id_fkey"
            columns: ["recipient_contact_id"]
            isOneToOne: false
            referencedRelation: "safe_return_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "safe_return_live_shares_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "safe_return_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      safe_return_sessions: {
        Row: {
          closed_at: string | null
          created_at: string
          emergency_note: string | null
          escalation_level: number
          id: string
          last_prompt_at: string | null
          last_safe_confirmation_at: string | null
          live_share_enabled: boolean
          notify_host_enabled: boolean
          notify_trip_crew_enabled: boolean
          plan_item_id: string | null
          status: string
          timer_end_at: string | null
          timer_start_at: string | null
          trigger_reason: string | null
          trip_id: string | null
          trusted_circle_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          emergency_note?: string | null
          escalation_level?: number
          id?: string
          last_prompt_at?: string | null
          last_safe_confirmation_at?: string | null
          live_share_enabled?: boolean
          notify_host_enabled?: boolean
          notify_trip_crew_enabled?: boolean
          plan_item_id?: string | null
          status?: string
          timer_end_at?: string | null
          timer_start_at?: string | null
          trigger_reason?: string | null
          trip_id?: string | null
          trusted_circle_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          emergency_note?: string | null
          escalation_level?: number
          id?: string
          last_prompt_at?: string | null
          last_safe_confirmation_at?: string | null
          live_share_enabled?: boolean
          notify_host_enabled?: boolean
          notify_trip_crew_enabled?: boolean
          plan_item_id?: string | null
          status?: string
          timer_end_at?: string | null
          timer_start_at?: string | null
          trigger_reason?: string | null
          trip_id?: string | null
          trusted_circle_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      saved_messages: {
        Row: {
          id: string
          message_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          id?: string
          message_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          id?: string
          message_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_messages_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      saved_places: {
        Row: {
          id: string
          place_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          id?: string
          place_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          id?: string
          place_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_places_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "discovery_places"
            referencedColumns: ["id"]
          },
        ]
      }
      search_history: {
        Row: {
          id: string
          query: string
          search_type: string | null
          searched_at: string
          user_id: string
        }
        Insert: {
          id?: string
          query: string
          search_type?: string | null
          searched_at?: string
          user_id: string
        }
        Update: {
          id?: string
          query?: string
          search_type?: string | null
          searched_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shared_moment_audit_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          moment_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          moment_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          moment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_moment_audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_audit_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "shared_moment_audit_events_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "shared_moments"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_moment_contributions: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          caption: string | null
          contributor_id: string
          created_at: string
          id: string
          media_asset_id: string | null
          moment_id: string
          post_id: string | null
          removed_at: string | null
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          caption?: string | null
          contributor_id: string
          created_at?: string
          id?: string
          media_asset_id?: string | null
          moment_id: string
          post_id?: string | null
          removed_at?: string | null
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          caption?: string | null
          contributor_id?: string
          created_at?: string
          id?: string
          media_asset_id?: string | null
          moment_id?: string
          post_id?: string | null
          removed_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_moment_contributions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_media_asset_id_fkey"
            columns: ["media_asset_id"]
            isOneToOne: false
            referencedRelation: "media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "shared_moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_contributions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_moment_memberships: {
        Row: {
          created_at: string
          id: string
          invited_by: string | null
          moment_id: string
          removed_at: string | null
          responded_at: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by?: string | null
          moment_id: string
          removed_at?: string | null
          responded_at?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string | null
          moment_id?: string
          removed_at?: string | null
          responded_at?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_moment_memberships_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_memberships_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "shared_moment_memberships_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "shared_moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      shared_moment_suggestions: {
        Row: {
          created_at: string
          id: string
          kind: string
          moment_id: string | null
          reason: string
          recipient_id: string
          responded_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          moment_id?: string | null
          reason: string
          recipient_id: string
          responded_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          moment_id?: string | null
          reason?: string
          recipient_id?: string
          responded_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_moment_suggestions_moment_id_fkey"
            columns: ["moment_id"]
            isOneToOne: false
            referencedRelation: "shared_moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_suggestions_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moment_suggestions_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      shared_moments: {
        Row: {
          archived_at: string | null
          created_at: string
          description: string | null
          id: string
          join_policy: string
          owner_id: string
          place_day_id: string | null
          place_id: string | null
          status: string
          title: string
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          join_policy?: string
          owner_id: string
          place_day_id?: string | null
          place_id?: string | null
          status?: string
          title: string
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          join_policy?: string
          owner_id?: string
          place_day_id?: string | null
          place_id?: string | null
          status?: string
          title?: string
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_moments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moments_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "shared_moments_place_day_id_fkey"
            columns: ["place_day_id"]
            isOneToOne: false
            referencedRelation: "place_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moments_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_moments_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      // hand-added; regenerate from live DB after apply (migration 2101_source_registry.sql)
      sources: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          key: string
          origin: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          key: string
          origin: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          key?: string
          origin?: string
        }
        Relationships: []
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      stamp_admin_audit_log: {
        Row: {
          action: string
          admin_id: string
          catalog_id: string | null
          created_at: string
          id: string
          notes: string | null
          target_catalog_id: string | null
          version_id: string | null
        }
        Insert: {
          action: string
          admin_id: string
          catalog_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          target_catalog_id?: string | null
          version_id?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          catalog_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          target_catalog_id?: string | null
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stamp_admin_audit_log_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_admin_audit_log_target_catalog_id_fkey"
            columns: ["target_catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_admin_audit_log_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "stamp_artwork_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_admires: {
        Row: {
          admirer_id: string
          created_at: string
          id: string
          user_stamp_id: string
        }
        Insert: {
          admirer_id: string
          created_at?: string
          id?: string
          user_stamp_id: string
        }
        Update: {
          admirer_id?: string
          created_at?: string
          id?: string
          user_stamp_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_admires_admirer_id_fkey"
            columns: ["admirer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_admires_admirer_id_fkey"
            columns: ["admirer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "stamp_admires_user_stamp_id_fkey"
            columns: ["user_stamp_id"]
            isOneToOne: false
            referencedRelation: "user_stamps"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_artwork_definitions: {
        Row: {
          accent: string
          background: string
          border_style: string
          border_weight: number
          caption_text: string | null
          category_label: string
          created_at: string
          has_glow: boolean
          has_shimmer: boolean
          icon_key: string
          id: string
          notes: string | null
          pattern: string
          rarity: string
          shape: string
          stamp_type: string
          texture: string
          updated_at: string
        }
        Insert: {
          accent: string
          background: string
          border_style?: string
          border_weight?: number
          caption_text?: string | null
          category_label: string
          created_at?: string
          has_glow?: boolean
          has_shimmer?: boolean
          icon_key: string
          id?: string
          notes?: string | null
          pattern?: string
          rarity: string
          shape?: string
          stamp_type: string
          texture?: string
          updated_at?: string
        }
        Update: {
          accent?: string
          background?: string
          border_style?: string
          border_weight?: number
          caption_text?: string | null
          category_label?: string
          created_at?: string
          has_glow?: boolean
          has_shimmer?: boolean
          icon_key?: string
          id?: string
          notes?: string | null
          pattern?: string
          rarity?: string
          shape?: string
          stamp_type?: string
          texture?: string
          updated_at?: string
        }
        Relationships: []
      }
      stamp_artwork_versions: {
        Row: {
          catalog_id: string
          composition: Json | null
          created_at: string
          created_by_admin_id: string | null
          format: string | null
          generation_metadata: Json | null
          generation_source: string
          height: number | null
          hero_path: string | null
          id: string
          model_version: string | null
          prompt_template_version: string | null
          prompt_used: string | null
          provider: string | null
          public_url: string | null
          qc_metadata: Json | null
          qc_status: string
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by_admin_id: string | null
          status: string
          storage_path: string | null
          thumbnail_path: string | null
          thumbnail_url: string | null
          width: number | null
        }
        Insert: {
          catalog_id: string
          composition?: Json | null
          created_at?: string
          created_by_admin_id?: string | null
          format?: string | null
          generation_metadata?: Json | null
          generation_source?: string
          height?: number | null
          hero_path?: string | null
          id?: string
          model_version?: string | null
          prompt_template_version?: string | null
          prompt_used?: string | null
          provider?: string | null
          public_url?: string | null
          qc_metadata?: Json | null
          qc_status?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by_admin_id?: string | null
          status?: string
          storage_path?: string | null
          thumbnail_path?: string | null
          thumbnail_url?: string | null
          width?: number | null
        }
        Update: {
          catalog_id?: string
          composition?: Json | null
          created_at?: string
          created_by_admin_id?: string | null
          format?: string | null
          generation_metadata?: Json | null
          generation_source?: string
          height?: number | null
          hero_path?: string | null
          id?: string
          model_version?: string | null
          prompt_template_version?: string | null
          prompt_used?: string | null
          provider?: string | null
          public_url?: string | null
          qc_metadata?: Json | null
          qc_status?: string
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by_admin_id?: string | null
          status?: string
          storage_path?: string | null
          thumbnail_path?: string | null
          thumbnail_url?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stamp_artwork_versions_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_award_events: {
        Row: {
          admin_id: string | null
          award_reason: string | null
          created_at: string
          criteria_snapshot: Json | null
          id: string
          idempotency_key: string
          source_id: string | null
          source_type: string | null
          stamp_definition_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_id?: string | null
          award_reason?: string | null
          created_at?: string
          criteria_snapshot?: Json | null
          id?: string
          idempotency_key: string
          source_id?: string | null
          source_type?: string | null
          stamp_definition_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_id?: string | null
          award_reason?: string | null
          created_at?: string
          criteria_snapshot?: Json | null
          id?: string
          idempotency_key?: string
          source_id?: string | null
          source_type?: string | null
          stamp_definition_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_award_events_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_award_events_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "stamp_award_events_stamp_definition_id_fkey"
            columns: ["stamp_definition_id"]
            isOneToOne: false
            referencedRelation: "stamp_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_award_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_award_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      stamp_campaigns: {
        Row: {
          created_at: string
          description: string | null
          ends_at: string | null
          id: string
          is_active: boolean
          metadata: Json | null
          name: string
          slug: string
          stamp_definition_id: string | null
          starts_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          ends_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name: string
          slug: string
          stamp_definition_id?: string | null
          starts_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          ends_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name?: string
          slug?: string
          stamp_definition_id?: string | null
          starts_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_campaigns_stamp_definition_id_fkey"
            columns: ["stamp_definition_id"]
            isOneToOne: false
            referencedRelation: "stamp_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_collection_items: {
        Row: {
          collection_id: string
          sort_order: number
          stamp_definition_id: string
        }
        Insert: {
          collection_id: string
          sort_order?: number
          stamp_definition_id: string
        }
        Update: {
          collection_id?: string
          sort_order?: number
          stamp_definition_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_collection_items_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "stamp_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_collection_items_stamp_definition_id_fkey"
            columns: ["stamp_definition_id"]
            isOneToOne: false
            referencedRelation: "stamp_definitions"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_collections: {
        Row: {
          created_at: string
          description: string | null
          icon_url: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          description?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
        }
        Relationships: []
      }
      stamp_definitions: {
        Row: {
          category: string
          city: string | null
          country: string | null
          created_at: string
          criteria: Json | null
          criteria_type: string
          description: string | null
          display_priority: number
          edition_size: number | null
          ends_at: string | null
          icon_url: string | null
          id: string
          is_active: boolean
          is_limited: boolean
          is_repeatable: boolean
          level_config: Json | null
          max_awards_per_user: number | null
          name: string
          rarity: string
          slug: string
          source_system: string | null
          stamp_type: string
          starts_at: string | null
          template_family: string | null
          universal_artwork_url: string | null
          updated_at: string
          visibility_default: string
        }
        Insert: {
          category: string
          city?: string | null
          country?: string | null
          created_at?: string
          criteria?: Json | null
          criteria_type?: string
          description?: string | null
          display_priority?: number
          edition_size?: number | null
          ends_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_limited?: boolean
          is_repeatable?: boolean
          level_config?: Json | null
          max_awards_per_user?: number | null
          name: string
          rarity?: string
          slug: string
          source_system?: string | null
          stamp_type: string
          starts_at?: string | null
          template_family?: string | null
          universal_artwork_url?: string | null
          updated_at?: string
          visibility_default?: string
        }
        Update: {
          category?: string
          city?: string | null
          country?: string | null
          created_at?: string
          criteria?: Json | null
          criteria_type?: string
          description?: string | null
          display_priority?: number
          edition_size?: number | null
          ends_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_limited?: boolean
          is_repeatable?: boolean
          level_config?: Json | null
          max_awards_per_user?: number | null
          name?: string
          rarity?: string
          slug?: string
          source_system?: string | null
          stamp_type?: string
          starts_at?: string | null
          template_family?: string | null
          universal_artwork_url?: string | null
          updated_at?: string
          visibility_default?: string
        }
        Relationships: []
      }
      stamp_generation_queue: {
        Row: {
          attempts: number
          catalog_id: string
          cleanup_error: string | null
          cleanup_error_paths: string[] | null
          created_at: string
          id: string
          last_error: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          priority: number
          requeue_count: number
          status: string
          triggered_by_action: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          catalog_id: string
          cleanup_error?: string | null
          cleanup_error_paths?: string[] | null
          created_at?: string
          id?: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          priority?: number
          requeue_count?: number
          status?: string
          triggered_by_action?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          catalog_id?: string
          cleanup_error?: string | null
          cleanup_error_paths?: string[] | null
          created_at?: string
          id?: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          priority?: number
          requeue_count?: number
          status?: string
          triggered_by_action?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_generation_queue_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      stamp_milestones: {
        Row: {
          celebrated_at: string
          milestone_level: number
          user_id: string
        }
        Insert: {
          celebrated_at?: string
          milestone_level: number
          user_id: string
        }
        Update: {
          celebrated_at?: string
          milestone_level?: number
          user_id?: string
        }
        Relationships: []
      }
      stamp_progress: {
        Row: {
          metadata: Json | null
          progress_count: number
          progress_target: number | null
          stamp_definition_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          metadata?: Json | null
          progress_count?: number
          progress_target?: number | null
          stamp_definition_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          metadata?: Json | null
          progress_count?: number
          progress_target?: number | null
          stamp_definition_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_progress_stamp_definition_id_fkey"
            columns: ["stamp_definition_id"]
            isOneToOne: false
            referencedRelation: "stamp_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stamp_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      stamp_reconciliation_log: {
        Row: {
          canonical_key: string | null
          catalog_id: string | null
          id: string
          needs_admin_review: boolean
          processed_at: string
          raw_city: string | null
          raw_country: string | null
          review_reason: string | null
          source_id: string
          source_table: string
          stamp_type: string | null
        }
        Insert: {
          canonical_key?: string | null
          catalog_id?: string | null
          id?: string
          needs_admin_review?: boolean
          processed_at?: string
          raw_city?: string | null
          raw_country?: string | null
          review_reason?: string | null
          source_id: string
          source_table: string
          stamp_type?: string | null
        }
        Update: {
          canonical_key?: string | null
          catalog_id?: string | null
          id?: string
          needs_admin_review?: boolean
          processed_at?: string
          raw_city?: string | null
          raw_country?: string | null
          review_reason?: string | null
          source_id?: string
          source_table?: string
          stamp_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stamp_reconciliation_log_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      stories: {
        Row: {
          allowed_user_ids: string[]
          caption: string | null
          close_friends_only: boolean
          created_at: string
          event_id: string | null
          expires_at: string
          hidden_user_ids: string[]
          hide_viewer_list: boolean
          id: string
          media_type: string
          media_url: string
          owner_id: string
          place_id: string | null
          saved_to_highlight_id: string | null
          state: Database["public"]["Enums"]["story_state"]
          trip_id: string | null
          visibility: Database["public"]["Enums"]["story_visibility"]
        }
        Insert: {
          allowed_user_ids?: string[]
          caption?: string | null
          close_friends_only?: boolean
          created_at?: string
          event_id?: string | null
          expires_at?: string
          hidden_user_ids?: string[]
          hide_viewer_list?: boolean
          id?: string
          media_type: string
          media_url: string
          owner_id: string
          place_id?: string | null
          saved_to_highlight_id?: string | null
          state?: Database["public"]["Enums"]["story_state"]
          trip_id?: string | null
          visibility?: Database["public"]["Enums"]["story_visibility"]
        }
        Update: {
          allowed_user_ids?: string[]
          caption?: string | null
          close_friends_only?: boolean
          created_at?: string
          event_id?: string | null
          expires_at?: string
          hidden_user_ids?: string[]
          hide_viewer_list?: boolean
          id?: string
          media_type?: string
          media_url?: string
          owner_id?: string
          place_id?: string | null
          saved_to_highlight_id?: string | null
          state?: Database["public"]["Enums"]["story_state"]
          trip_id?: string | null
          visibility?: Database["public"]["Enums"]["story_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "stories_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      story_reactions: {
        Row: {
          created_at: string
          emoji: string
          story_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          story_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          story_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_reactions_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      story_replies: {
        Row: {
          created_at: string
          id: string
          message: string
          story_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          story_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          story_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_replies_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      story_views: {
        Row: {
          story_id: string
          viewed_at: string
          viewer_id: string
        }
        Insert: {
          story_id: string
          viewed_at?: string
          viewer_id: string
        }
        Update: {
          story_id?: string
          viewed_at?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_views_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          created_at: string
          id: string
          source_id: string
          source_type: string
          status: string
          suppressed: boolean
          suppressed_at: string | null
          tagged_user_id: string
          tagger_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          source_id: string
          source_type: string
          status?: string
          suppressed?: boolean
          suppressed_at?: string | null
          tagged_user_id: string
          tagger_id: string
        }
        Update: {
          created_at?: string
          id?: string
          source_id?: string
          source_type?: string
          status?: string
          suppressed?: boolean
          suppressed_at?: string | null
          tagged_user_id?: string
          tagger_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tags_tagged_user_id_fkey"
            columns: ["tagged_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_tagged_user_id_fkey"
            columns: ["tagged_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "tags_tagger_id_fkey"
            columns: ["tagger_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_tagger_id_fkey"
            columns: ["tagger_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      telegraph_chat_suggestions: {
        Row: {
          acted_on_at: string | null
          action_type: string
          category: string
          circle_id: string | null
          created_at: string
          dismissed_at: string | null
          expires_at: string
          id: string
          intent_type: string
          location_context: string | null
          reason: string
          recommendation_id: string | null
          source_message_id: string | null
          status: string
          thread_id: string
          time_context: string | null
          title: string
          trip_id: string | null
          user_id: string
        }
        Insert: {
          acted_on_at?: string | null
          action_type?: string
          category?: string
          circle_id?: string | null
          created_at?: string
          dismissed_at?: string | null
          expires_at?: string
          id?: string
          intent_type: string
          location_context?: string | null
          reason: string
          recommendation_id?: string | null
          source_message_id?: string | null
          status?: string
          thread_id: string
          time_context?: string | null
          title: string
          trip_id?: string | null
          user_id: string
        }
        Update: {
          acted_on_at?: string | null
          action_type?: string
          category?: string
          circle_id?: string | null
          created_at?: string
          dismissed_at?: string | null
          expires_at?: string
          id?: string
          intent_type?: string
          location_context?: string | null
          reason?: string
          recommendation_id?: string | null
          source_message_id?: string | null
          status?: string
          thread_id?: string
          time_context?: string | null
          title?: string
          trip_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "telegraph_chat_suggestions_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_circle_id_fkey"
            columns: ["circle_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "message_threads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegraph_chat_suggestions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      thread_reports: {
        Row: {
          created_at: string
          id: string
          reason: string
          reporter_id: string
          thread_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason: string
          reporter_id: string
          thread_id: string
        }
        Update: {
          created_at?: string
          id?: string
          reason?: string
          reporter_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "thread_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      traveler_passports: {
        Row: {
          created_at: string
          expiry_date: string | null
          id: string
          is_primary: boolean
          issuing_country: string
          label: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expiry_date?: string | null
          id?: string
          is_primary?: boolean
          issuing_country: string
          label?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expiry_date?: string | null
          id?: string
          is_primary?: boolean
          issuing_country?: string
          label?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trip_activity_log: {
        Row: {
          actor_id: string
          created_at: string
          event_type: string
          id: string
          metadata: Json
          trip_id: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          trip_id: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_activity_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_activity_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_activity_log_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_area_preferences: {
        Row: {
          priorities: Json
          sleep_vs_play: string | null
          trip_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          priorities?: Json
          sleep_vs_play?: string | null
          trip_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          priorities?: Json
          sleep_vs_play?: string | null
          trip_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_area_preferences_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_autopilot_proposals: {
        Row: {
          changes: Json
          created_at: string
          dedupe_key: string
          id: string
          issue_type: string
          reason: string
          resolved_at: string | null
          severity: string
          status: string
          trip_id: string
          user_id: string
        }
        Insert: {
          changes?: Json
          created_at?: string
          dedupe_key: string
          id?: string
          issue_type: string
          reason: string
          resolved_at?: string | null
          severity?: string
          status?: string
          trip_id: string
          user_id: string
        }
        Update: {
          changes?: Json
          created_at?: string
          dedupe_key?: string
          id?: string
          issue_type?: string
          reason?: string
          resolved_at?: string | null
          severity?: string
          status?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_autopilot_proposals_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_autopilot_settings: {
        Row: {
          allow_move_flexible: boolean
          allow_move_optional: boolean
          allow_remove_optional: boolean
          enabled: boolean
          trip_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_move_flexible?: boolean
          allow_move_optional?: boolean
          allow_remove_optional?: boolean
          enabled?: boolean
          trip_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_move_flexible?: boolean
          allow_move_optional?: boolean
          allow_remove_optional?: boolean
          enabled?: boolean
          trip_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_autopilot_settings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_availability: {
        Row: {
          open_days: Json
          trip_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          open_days?: Json
          trip_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          open_days?: Json
          trip_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_availability_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_availability_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_availability_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_budget: {
        Row: {
          breakdown: Json
          created_at: string
          currency: string
          id: string
          spent: number
          total_budget: number | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          breakdown?: Json
          created_at?: string
          currency?: string
          id?: string
          spent?: number
          total_budget?: number | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          breakdown?: Json
          created_at?: string
          currency?: string
          id?: string
          spent?: number
          total_budget?: number | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_budget_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_checklist_items: {
        Row: {
          assigned_to: string | null
          checklist_id: string
          created_at: string
          due_date: string | null
          id: string
          is_done: boolean
          label: string
          sort_order: number
          trip_id: string
        }
        Insert: {
          assigned_to?: string | null
          checklist_id: string
          created_at?: string
          due_date?: string | null
          id?: string
          is_done?: boolean
          label: string
          sort_order?: number
          trip_id: string
        }
        Update: {
          assigned_to?: string | null
          checklist_id?: string
          created_at?: string
          due_date?: string | null
          id?: string
          is_done?: boolean
          label?: string
          sort_order?: number
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_checklist_items_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_checklist_items_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_checklist_items_checklist_id_fkey"
            columns: ["checklist_id"]
            isOneToOne: false
            referencedRelation: "trip_checklists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_checklist_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_checklists: {
        Row: {
          created_at: string
          created_by: string
          id: string
          title: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          title: string
          trip_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          title?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_checklists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_checklists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_checklists_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_crew_location_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          trip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          trip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_crew_location_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_crew_location_preferences: {
        Row: {
          created_at: string
          default_visibility: string
          ghost_mode_enabled: boolean
          id: string
          share_arrival_status: boolean
          share_safe_return_status: boolean
          trip_id: string
          updated_at: string
          user_id: string
          visibility_default: string
        }
        Insert: {
          created_at?: string
          default_visibility?: string
          ghost_mode_enabled?: boolean
          id?: string
          share_arrival_status?: boolean
          share_safe_return_status?: boolean
          trip_id: string
          updated_at?: string
          user_id: string
          visibility_default?: string
        }
        Update: {
          created_at?: string
          default_visibility?: string
          ghost_mode_enabled?: boolean
          id?: string
          share_arrival_status?: boolean
          share_safe_return_status?: boolean
          trip_id?: string
          updated_at?: string
          user_id?: string
          visibility_default?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_crew_location_preferences_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_crew_location_sessions: {
        Row: {
          allowed_member_ids: string[] | null
          created_at: string
          ended_at: string | null
          expires_at: string
          id: string
          last_location_snapshot_id: string | null
          started_at: string
          status: string
          stopped_at: string | null
          trip_id: string
          user_id: string
          visibility_level: string
        }
        Insert: {
          allowed_member_ids?: string[] | null
          created_at?: string
          ended_at?: string | null
          expires_at: string
          id?: string
          last_location_snapshot_id?: string | null
          started_at?: string
          status?: string
          stopped_at?: string | null
          trip_id: string
          user_id: string
          visibility_level?: string
        }
        Update: {
          allowed_member_ids?: string[] | null
          created_at?: string
          ended_at?: string | null
          expires_at?: string
          id?: string
          last_location_snapshot_id?: string | null
          started_at?: string
          status?: string
          stopped_at?: string | null
          trip_id?: string
          user_id?: string
          visibility_level?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_crew_location_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_crew_location_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_destinations: {
        Row: {
          arrival_date: string | null
          city: string
          country: string | null
          created_at: string
          departure_date: string | null
          id: string
          lat: number | null
          lng: number | null
          place_id: string | null
          position: number
          trip_id: string
        }
        Insert: {
          arrival_date?: string | null
          city: string
          country?: string | null
          created_at?: string
          departure_date?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          place_id?: string | null
          position?: number
          trip_id: string
        }
        Update: {
          arrival_date?: string | null
          city?: string
          country?: string | null
          created_at?: string
          departure_date?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          place_id?: string | null
          position?: number
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_destinations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_documents: {
        Row: {
          content: string | null
          created_at: string
          creator_id: string
          document_type: string
          id: string
          is_private: boolean
          title: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          creator_id: string
          document_type?: string
          id?: string
          is_private?: boolean
          title: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          creator_id?: string
          document_type?: string
          id?: string
          is_private?: boolean
          title?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_documents_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_documents_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_documents_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_invite_link_attempts: {
        Row: {
          claimed_at: string
          link_id: string
          user_id: string
        }
        Insert: {
          claimed_at?: string
          link_id: string
          user_id: string
        }
        Update: {
          claimed_at?: string
          link_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_invite_link_attempts_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "trip_invite_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_invite_link_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_invite_link_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_invite_links: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          max_uses: number | null
          revoked_at: string | null
          token: string
          trip_id: string
          use_count: number
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          revoked_at?: string | null
          token: string
          trip_id: string
          use_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          max_uses?: number | null
          revoked_at?: string | null
          token?: string
          trip_id?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "trip_invite_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_invite_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_invite_links_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_join_requests: {
        Row: {
          created_at: string
          id: string
          message: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          trip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          trip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_join_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_join_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_join_requests_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_members: {
        Row: {
          created_at: string
          invite_link_id: string | null
          joined_at: string | null
          permissions: Json | null
          role: Database["public"]["Enums"]["member_role"]
          status: string
          trip_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          invite_link_id?: string | null
          joined_at?: string | null
          permissions?: Json | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: string
          trip_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          invite_link_id?: string | null
          joined_at?: string | null
          permissions?: Json | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: string
          trip_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_members_invite_link_id_fkey"
            columns: ["invite_link_id"]
            isOneToOne: false
            referencedRelation: "trip_invite_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_members_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_notes: {
        Row: {
          author_id: string
          content: string
          created_at: string
          id: string
          is_private: boolean
          title: string | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          content: string
          created_at?: string
          id?: string
          is_private?: boolean
          title?: string | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          content?: string
          created_at?: string
          id?: string
          is_private?: boolean
          title?: string | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trip_notes_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_plan_items: {
        Row: {
          added_by: string | null
          category: string
          city: string | null
          country: string | null
          created_at: string
          creator_id: string
          day_date: string | null
          description: string | null
          ends_at: string | null
          id: string
          lat: number | null
          lng: number | null
          location_is_private: boolean
          location_name: string | null
          lock_type: string
          notes: string | null
          removed_at: string | null
          route_stop_id: string | null
          sort_order: number
          source_id: string | null
          source_type: string
          starts_at: string | null
          status: string
          title: string
          trip_id: string
          updated_at: string
          visibility: string
        }
        Insert: {
          added_by?: string | null
          category?: string
          city?: string | null
          country?: string | null
          created_at?: string
          creator_id: string
          day_date?: string | null
          description?: string | null
          ends_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          location_is_private?: boolean
          location_name?: string | null
          lock_type?: string
          notes?: string | null
          removed_at?: string | null
          route_stop_id?: string | null
          sort_order?: number
          source_id?: string | null
          source_type?: string
          starts_at?: string | null
          status?: string
          title: string
          trip_id: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          added_by?: string | null
          category?: string
          city?: string | null
          country?: string | null
          created_at?: string
          creator_id?: string
          day_date?: string | null
          description?: string | null
          ends_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          location_is_private?: boolean
          location_name?: string | null
          lock_type?: string
          notes?: string | null
          removed_at?: string | null
          route_stop_id?: string | null
          sort_order?: number
          source_id?: string | null
          source_type?: string
          starts_at?: string | null
          status?: string
          title?: string
          trip_id?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_plan_items_route_stop_id_fkey"
            columns: ["route_stop_id"]
            isOneToOne: false
            referencedRelation: "route_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_plan_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_readiness_items: {
        Row: {
          action_ref: Json | null
          category: string
          computed_at: string
          dedupe_key: string
          detail: string | null
          due_at: string | null
          id: string
          severity: string
          status: string
          title: string
          trip_id: string
          user_id: string | null
        }
        Insert: {
          action_ref?: Json | null
          category: string
          computed_at?: string
          dedupe_key: string
          detail?: string | null
          due_at?: string | null
          id?: string
          severity?: string
          status: string
          title: string
          trip_id: string
          user_id?: string | null
        }
        Update: {
          action_ref?: Json | null
          category?: string
          computed_at?: string
          dedupe_key?: string
          detail?: string | null
          due_at?: string | null
          id?: string
          severity?: string
          status?: string
          title?: string
          trip_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_readiness_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_readiness_snapshots: {
        Row: {
          computed_at: string
          id: string
          score: number
          snapshot_date: string
          trip_id: string
        }
        Insert: {
          computed_at?: string
          id?: string
          score: number
          snapshot_date: string
          trip_id: string
        }
        Update: {
          computed_at?: string
          id?: string
          score?: number
          snapshot_date?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_readiness_snapshots_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_reminders: {
        Row: {
          created_at: string
          id: string
          is_sent: boolean
          remind_at: string
          title: string
          trip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_sent?: boolean
          remind_at: string
          title: string
          trip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_sent?: boolean
          remind_at?: string
          title?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_reminders_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_reminders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_reminders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_reservations: {
        Row: {
          cancellation_deadline_at: string | null
          confirmation_ref: string | null
          created_at: string
          created_from: string
          ends_at: string | null
          extraction: Json | null
          extraction_confidence: number | null
          id: string
          location_name: string | null
          raw_text: string | null
          starts_at: string | null
          status: string
          title: string
          trip_id: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cancellation_deadline_at?: string | null
          confirmation_ref?: string | null
          created_at?: string
          created_from?: string
          ends_at?: string | null
          extraction?: Json | null
          extraction_confidence?: number | null
          id?: string
          location_name?: string | null
          raw_text?: string | null
          starts_at?: string | null
          status?: string
          title: string
          trip_id: string
          type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cancellation_deadline_at?: string | null
          confirmation_ref?: string | null
          created_at?: string
          created_from?: string
          ends_at?: string | null
          extraction?: Json | null
          extraction_confidence?: number | null
          id?: string
          location_name?: string | null
          raw_text?: string | null
          starts_at?: string | null
          status?: string
          title?: string
          trip_id?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_reservations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_saved_places: {
        Row: {
          id: string
          lat: number | null
          lng: number | null
          notes: string | null
          place_id: string | null
          place_name: string
          place_type: string | null
          saved_at: string
          trip_id: string
          user_id: string
        }
        Insert: {
          id?: string
          lat?: number | null
          lng?: number | null
          notes?: string | null
          place_id?: string | null
          place_name: string
          place_type?: string | null
          saved_at?: string
          trip_id: string
          user_id: string
        }
        Update: {
          id?: string
          lat?: number | null
          lng?: number | null
          notes?: string | null
          place_id?: string | null
          place_name?: string
          place_type?: string | null
          saved_at?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_saved_places_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_saved_places_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_saved_places_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trip_traveler_passports: {
        Row: {
          created_at: string
          passport_id: string
          trip_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          passport_id: string
          trip_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          passport_id?: string
          trip_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_traveler_passports_passport_id_fkey"
            columns: ["passport_id"]
            isOneToOne: false
            referencedRelation: "traveler_passports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_traveler_passports_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          allow_friend_suggestions: boolean
          allow_join_requests: boolean
          allow_trip_crew_invites: boolean
          cover_image_height: number | null
          cover_image_width: number | null
          cover_media_type: string | null
          cover_url: string | null
          created_at: string
          delayed_posting_default: boolean
          destination_city: string
          destination_country: string | null
          destination_lat: number | null
          destination_lng: number | null
          destination_place_id: string | null
          end_date: string | null
          id: string
          max_members: number | null
          neighborhoods: string[]
          open_to_meet: boolean
          original_language: string | null
          owner_id: string
          plan_edit_permission: string
          precise_location_visible: boolean
          progress: number
          reminder_delivered_at: string | null
          reminder_retry_count: number
          reminder_sent_at: string | null
          show_destination_city: boolean
          show_exact_dates: boolean
          show_header_publicly: boolean
          show_in_discovery: boolean
          show_on_profile: boolean
          start_date: string | null
          status: Database["public"]["Enums"]["trip_status"]
          timezone: string | null
          title: string
          travel_style: string | null
          trip_notes: string | null
          trip_type: string | null
          updated_at: string
          visibility: Database["public"]["Enums"]["trip_visibility"]
        }
        Insert: {
          allow_friend_suggestions?: boolean
          allow_join_requests?: boolean
          allow_trip_crew_invites?: boolean
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_media_type?: string | null
          cover_url?: string | null
          created_at?: string
          delayed_posting_default?: boolean
          destination_city: string
          destination_country?: string | null
          destination_lat?: number | null
          destination_lng?: number | null
          destination_place_id?: string | null
          end_date?: string | null
          id?: string
          max_members?: number | null
          neighborhoods?: string[]
          open_to_meet?: boolean
          original_language?: string | null
          owner_id: string
          plan_edit_permission?: string
          precise_location_visible?: boolean
          progress?: number
          reminder_delivered_at?: string | null
          reminder_retry_count?: number
          reminder_sent_at?: string | null
          show_destination_city?: boolean
          show_exact_dates?: boolean
          show_header_publicly?: boolean
          show_in_discovery?: boolean
          show_on_profile?: boolean
          start_date?: string | null
          status?: Database["public"]["Enums"]["trip_status"]
          timezone?: string | null
          title: string
          travel_style?: string | null
          trip_notes?: string | null
          trip_type?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["trip_visibility"]
        }
        Update: {
          allow_friend_suggestions?: boolean
          allow_join_requests?: boolean
          allow_trip_crew_invites?: boolean
          cover_image_height?: number | null
          cover_image_width?: number | null
          cover_media_type?: string | null
          cover_url?: string | null
          created_at?: string
          delayed_posting_default?: boolean
          destination_city?: string
          destination_country?: string | null
          destination_lat?: number | null
          destination_lng?: number | null
          destination_place_id?: string | null
          end_date?: string | null
          id?: string
          max_members?: number | null
          neighborhoods?: string[]
          open_to_meet?: boolean
          original_language?: string | null
          owner_id?: string
          plan_edit_permission?: string
          precise_location_visible?: boolean
          progress?: number
          reminder_delivered_at?: string | null
          reminder_retry_count?: number
          reminder_sent_at?: string | null
          show_destination_city?: boolean
          show_exact_dates?: boolean
          show_header_publicly?: boolean
          show_in_discovery?: boolean
          show_on_profile?: boolean
          start_date?: string | null
          status?: Database["public"]["Enums"]["trip_status"]
          timezone?: string | null
          title?: string
          travel_style?: string | null
          trip_notes?: string | null
          trip_type?: string | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["trip_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "trips_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_admin_actions: {
        Row: {
          action_type: string
          admin_id: string
          created_at: string
          id: string
          metadata: Json
          reason: string
          source_id: string | null
          target_user: string
        }
        Insert: {
          action_type: string
          admin_id: string
          created_at?: string
          id?: string
          metadata?: Json
          reason: string
          source_id?: string | null
          target_user: string
        }
        Update: {
          action_type?: string
          admin_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          reason?: string
          source_id?: string | null
          target_user?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_admin_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_admin_actions_target_user_fkey"
            columns: ["target_user"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_admin_actions_target_user_fkey"
            columns: ["target_user"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_caps: {
        Row: {
          category: string
          ceiling_score: number
          created_at: string
          expires_at: string | null
          id: string
          lifted_at: string | null
          lifted_by: string | null
          reason_code: string
          source_event_id: string | null
          user_id: string
        }
        Insert: {
          category: string
          ceiling_score: number
          created_at?: string
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          reason_code: string
          source_event_id?: string | null
          user_id: string
        }
        Update: {
          category?: string
          ceiling_score?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          reason_code?: string
          source_event_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_caps_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_caps_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_caps_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "trust_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_caps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_caps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_events: {
        Row: {
          category: string
          created_at: string
          delta: number
          event_type: string
          id: string
          metadata: Json
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          source_id: string | null
          source_type: string
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          delta?: number
          event_type: string
          id?: string
          metadata?: Json
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          source_id?: string | null
          source_type?: string
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          delta?: number
          event_type?: string
          id?: string
          metadata?: Json
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          source_id?: string | null
          source_type?: string
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_events_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_events_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_profiles: {
        Row: {
          communication: number
          community_value: number
          content_quality: number
          created_at: string
          guide_accuracy: number
          host_quality: number
          last_recalculated_at: string
          location_honesty: number
          on_probation: boolean
          overall_score: number
          passport_authenticity: number
          plan_attendance: number
          probation_ends_at: string | null
          public_level: string
          respect_safety: number
          updated_at: string
          user_id: string
        }
        Insert: {
          communication?: number
          community_value?: number
          content_quality?: number
          created_at?: string
          guide_accuracy?: number
          host_quality?: number
          last_recalculated_at?: string
          location_honesty?: number
          on_probation?: boolean
          overall_score?: number
          passport_authenticity?: number
          plan_attendance?: number
          probation_ends_at?: string | null
          public_level?: string
          respect_safety?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          communication?: number
          community_value?: number
          content_quality?: number
          created_at?: string
          guide_accuracy?: number
          host_quality?: number
          last_recalculated_at?: string
          location_honesty?: number
          on_probation?: boolean
          overall_score?: number
          passport_authenticity?: number
          plan_attendance?: number
          probation_ends_at?: string | null
          public_level?: string
          respect_safety?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_restrictions: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          lifted_at: string | null
          lifted_by: string | null
          reason: string | null
          restriction_type: string
          source_event_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          reason?: string | null
          restriction_type: string
          source_event_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          reason?: string | null
          restriction_type?: string
          source_event_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_restrictions_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_restrictions_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_restrictions_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "trust_events"
            referencedColumns: ["id"]
          },
        ]
      }
      trust_reviews: {
        Row: {
          assigned_to: string | null
          created_at: string
          id: string
          metadata: Json
          notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          review_type: string
          source_event_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_type: string
          source_event_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_type?: string
          source_event_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trust_reviews_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_reviews_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_reviews_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_reviews_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "trust_reviews_source_event_id_fkey"
            columns: ["source_event_id"]
            isOneToOne: false
            referencedRelation: "trust_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_reviews_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trust_reviews_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      trust_settings: {
        Row: {
          daily_cap_gem_save: number
          daily_cap_guide_verify: number
          daily_cap_plan_attend: number
          decay_half_life_days: number
          gaming_checkin_cluster_limit: number
          gaming_mutual_rate_threshold: number
          gaming_rapid_jump_points: number
          id: number
          level_building_trust: number
          level_city_trusted: number
          level_highly_trusted: number
          level_reliable: number
          level_trusted: number
          updated_at: string
          weekly_cap_gem_save: number
          weekly_cap_guide_verify: number
          weekly_cap_plan_attend: number
          weight_communication: number
          weight_community_value: number
          weight_content_quality: number
          weight_guide_accuracy: number
          weight_host_quality: number
          weight_location_honesty: number
          weight_passport_auth: number
          weight_plan_attendance: number
          weight_respect_safety: number
        }
        Insert: {
          daily_cap_gem_save?: number
          daily_cap_guide_verify?: number
          daily_cap_plan_attend?: number
          decay_half_life_days?: number
          gaming_checkin_cluster_limit?: number
          gaming_mutual_rate_threshold?: number
          gaming_rapid_jump_points?: number
          id?: number
          level_building_trust?: number
          level_city_trusted?: number
          level_highly_trusted?: number
          level_reliable?: number
          level_trusted?: number
          updated_at?: string
          weekly_cap_gem_save?: number
          weekly_cap_guide_verify?: number
          weekly_cap_plan_attend?: number
          weight_communication?: number
          weight_community_value?: number
          weight_content_quality?: number
          weight_guide_accuracy?: number
          weight_host_quality?: number
          weight_location_honesty?: number
          weight_passport_auth?: number
          weight_plan_attendance?: number
          weight_respect_safety?: number
        }
        Update: {
          daily_cap_gem_save?: number
          daily_cap_guide_verify?: number
          daily_cap_plan_attend?: number
          decay_half_life_days?: number
          gaming_checkin_cluster_limit?: number
          gaming_mutual_rate_threshold?: number
          gaming_rapid_jump_points?: number
          id?: number
          level_building_trust?: number
          level_city_trusted?: number
          level_highly_trusted?: number
          level_reliable?: number
          level_trusted?: number
          updated_at?: string
          weekly_cap_gem_save?: number
          weekly_cap_guide_verify?: number
          weekly_cap_plan_attend?: number
          weight_communication?: number
          weight_community_value?: number
          weight_content_quality?: number
          weight_guide_accuracy?: number
          weight_host_quality?: number
          weight_location_honesty?: number
          weight_passport_auth?: number
          weight_plan_attendance?: number
          weight_respect_safety?: number
        }
        Relationships: []
      }
      universal_stamp_catalog: {
        Row: {
          active_version_id: string | null
          canonical_location_key: string
          city: string | null
          country: string
          country_code: string | null
          created_at: string
          display_name: string
          earn_count: number
          id: string
          identity_key: string | null
          lat: number | null
          lng: number | null
          neighborhood: string | null
          place_ids: Json | null
          prompt_template_version: string
          region: string | null
          stamp_type: string
          status: string
          updated_at: string
        }
        Insert: {
          active_version_id?: string | null
          canonical_location_key: string
          city?: string | null
          country: string
          country_code?: string | null
          created_at?: string
          display_name: string
          earn_count?: number
          id?: string
          identity_key?: string | null
          lat?: number | null
          lng?: number | null
          neighborhood?: string | null
          place_ids?: Json | null
          prompt_template_version?: string
          region?: string | null
          stamp_type: string
          status?: string
          updated_at?: string
        }
        Update: {
          active_version_id?: string | null
          canonical_location_key?: string
          city?: string | null
          country?: string
          country_code?: string | null
          created_at?: string
          display_name?: string
          earn_count?: number
          id?: string
          identity_key?: string | null
          lat?: number | null
          lng?: number | null
          neighborhood?: string | null
          place_ids?: Json | null
          prompt_template_version?: string
          region?: string | null
          stamp_type?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_catalog_active_version"
            columns: ["active_version_id"]
            isOneToOne: false
            referencedRelation: "stamp_artwork_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_account_states: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          reason: string | null
          set_by: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
          set_by?: string | null
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
          set_by?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_account_states_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_account_states_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_account_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_account_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_availability: {
        Row: {
          open_to_meet: boolean
          strict_mode: boolean
          updated_at: string
          user_id: string
          weekly_days: Json
        }
        Insert: {
          open_to_meet?: boolean
          strict_mode?: boolean
          updated_at?: string
          user_id: string
          weekly_days?: Json
        }
        Update: {
          open_to_meet?: boolean
          strict_mode?: boolean
          updated_at?: string
          user_id?: string
          weekly_days?: Json
        }
        Relationships: [
          {
            foreignKeyName: "user_availability_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_availability_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_deletion_requests: {
        Row: {
          cancelled_at: string | null
          executed_at: string | null
          executed_by: string | null
          requested_at: string
          scheduled_at: string
          status: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          executed_at?: string | null
          executed_by?: string | null
          requested_at?: string
          scheduled_at: string
          status?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          executed_at?: string | null
          executed_by?: string | null
          requested_at?: string
          scheduled_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      user_follows: {
        Row: {
          created_at: string
          follower_id: string
          following_id: string
        }
        Insert: {
          created_at?: string
          follower_id: string
          following_id: string
        }
        Update: {
          created_at?: string
          follower_id?: string
          following_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_follows_follower_id_fkey"
            columns: ["follower_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_friendships: {
        Row: {
          accepted_request_id: string | null
          created_at: string | null
          user_a: string
          user_b: string
        }
        Insert: {
          accepted_request_id?: string | null
          created_at?: string | null
          user_a: string
          user_b: string
        }
        Update: {
          accepted_request_id?: string | null
          created_at?: string | null
          user_a?: string
          user_b?: string
        }
        Relationships: []
      }
      user_hashtag_follows: {
        Row: {
          created_at: string
          hashtag_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          hashtag_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          hashtag_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_hashtag_follows_hashtag_id_fkey"
            columns: ["hashtag_id"]
            isOneToOne: false
            referencedRelation: "hashtags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_hashtag_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_hashtag_follows_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_interaction_cooldowns: {
        Row: {
          cooldown_type: string
          created_at: string
          expires_at: string | null
          id: string
          target_user_id: string
          user_id: string
        }
        Insert: {
          cooldown_type: string
          created_at?: string
          expires_at?: string | null
          id?: string
          target_user_id: string
          user_id: string
        }
        Update: {
          cooldown_type?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          target_user_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_interaction_cooldowns_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_interaction_cooldowns_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_interaction_cooldowns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_interaction_cooldowns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_location_preferences: {
        Row: {
          created_at: string
          discovery_visibility: string | null
          hotel_blur_enabled: boolean
          location_mode: string
          pulse_visibility: string | null
          safe_return_enabled: boolean
          sharing_paused: boolean
          trusted_circle_share: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          discovery_visibility?: string | null
          hotel_blur_enabled?: boolean
          location_mode?: string
          pulse_visibility?: string | null
          safe_return_enabled?: boolean
          sharing_paused?: boolean
          trusted_circle_share?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          discovery_visibility?: string | null
          hotel_blur_enabled?: boolean
          location_mode?: string
          pulse_visibility?: string | null
          safe_return_enabled?: boolean
          sharing_paused?: boolean
          trusted_circle_share?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_location_privacy: {
        Row: {
          ghost_mode: boolean
          sharing: string
          stale_minutes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ghost_mode?: boolean
          sharing?: string
          stale_minutes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ghost_mode?: boolean
          sharing?: string
          stale_minutes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_location_privacy_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_location_privacy_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_location_state: {
        Row: {
          accuracy_meters: number | null
          city: string | null
          country: string | null
          country_code: string | null
          district: string | null
          formatted_location: string | null
          geog: unknown
          last_known_at: string | null
          lat: number | null
          lng: number | null
          manual_city: string | null
          manual_country: string | null
          manual_selected_at: string | null
          permission_status: string | null
          source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          accuracy_meters?: number | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          district?: string | null
          formatted_location?: string | null
          geog?: unknown
          last_known_at?: string | null
          lat?: number | null
          lng?: number | null
          manual_city?: string | null
          manual_country?: string | null
          manual_selected_at?: string | null
          permission_status?: string | null
          source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          accuracy_meters?: number | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          district?: string | null
          formatted_location?: string | null
          geog?: unknown
          last_known_at?: string | null
          lat?: number | null
          lng?: number | null
          manual_city?: string | null
          manual_country?: string | null
          manual_selected_at?: string | null
          permission_status?: string | null
          source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_locations: {
        Row: {
          approx_lat: number | null
          approx_lng: number | null
          city: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          approx_lat?: number | null
          approx_lng?: number | null
          city?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          approx_lat?: number | null
          approx_lng?: number | null
          city?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_locations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_locations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_message_settings: {
        Row: {
          allow_circle_member_messages: boolean
          allow_message_requests: boolean
          allow_trip_member_messages: boolean
          message_privacy: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_circle_member_messages?: boolean
          allow_message_requests?: boolean
          allow_trip_member_messages?: boolean
          message_privacy?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_circle_member_messages?: boolean
          allow_message_requests?: boolean
          allow_trip_member_messages?: boolean
          message_privacy?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_message_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_message_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_mutes: {
        Row: {
          created_at: string
          id: string
          mute_types: string[]
          muted_id: string
          muter_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          mute_types?: string[]
          muted_id: string
          muter_id: string
        }
        Update: {
          created_at?: string
          id?: string
          mute_types?: string[]
          muted_id?: string
          muter_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_mutes_muted_id_fkey"
            columns: ["muted_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_mutes_muted_id_fkey"
            columns: ["muted_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_mutes_muter_id_fkey"
            columns: ["muter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_mutes_muter_id_fkey"
            columns: ["muter_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_preference_events: {
        Row: {
          category: string
          created_at: string
          id: string
          recommendation_id: string
          signal: string
          trip_id: string | null
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          recommendation_id: string
          signal: string
          trip_id?: string | null
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          recommendation_id?: string
          signal?: string
          trip_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preference_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preference_profiles: {
        Row: {
          created_at: string
          explicit_preferences_json: string
          id: string
          inferred_preferences_json: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          explicit_preferences_json?: string
          id?: string
          inferred_preferences_json?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          explicit_preferences_json?: string
          id?: string
          inferred_preferences_json?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_privacy_settings: {
        Row: {
          age_restriction_enabled: boolean
          allow_location_sharing: boolean
          id: string
          profile_visibility: string | null
          show_online_status: boolean
          updated_at: string
          user_id: string
          who_can_tag: string | null
        }
        Insert: {
          age_restriction_enabled?: boolean
          allow_location_sharing?: boolean
          id?: string
          profile_visibility?: string | null
          show_online_status?: boolean
          updated_at?: string
          user_id: string
          who_can_tag?: string | null
        }
        Update: {
          age_restriction_enabled?: boolean
          allow_location_sharing?: boolean
          id?: string
          profile_visibility?: string | null
          show_online_status?: boolean
          updated_at?: string
          user_id?: string
          who_can_tag?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_privacy_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_privacy_settings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_recent_places: {
        Row: {
          id: string
          place_snapshot: Json
          used_at: string
          used_for: string | null
          user_id: string
        }
        Insert: {
          id?: string
          place_snapshot?: Json
          used_at?: string
          used_for?: string | null
          user_id: string
        }
        Update: {
          id?: string
          place_snapshot?: Json
          used_at?: string
          used_for?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_restrictions: {
        Row: {
          created_at: string
          id: string
          options: Json
          restricted_id: string
          restrictor_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          options?: Json
          restricted_id: string
          restrictor_id: string
        }
        Update: {
          created_at?: string
          id?: string
          options?: Json
          restricted_id?: string
          restrictor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_restrictions_restricted_id_fkey"
            columns: ["restricted_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_restrictions_restricted_id_fkey"
            columns: ["restricted_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_restrictions_restrictor_id_fkey"
            columns: ["restrictor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_restrictions_restrictor_id_fkey"
            columns: ["restrictor_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_saves: {
        Row: {
          created_at: string
          id: string
          saved_id: string
          saver_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          saved_id: string
          saver_id: string
        }
        Update: {
          created_at?: string
          id?: string
          saved_id?: string
          saver_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_saves_saved_id_fkey"
            columns: ["saved_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_saves_saved_id_fkey"
            columns: ["saved_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_saves_saver_id_fkey"
            columns: ["saver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_saves_saver_id_fkey"
            columns: ["saver_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_stamp_showcase: {
        Row: {
          created_at: string
          id: string
          rank: number
          user_id: string
          user_stamp_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          rank?: number
          user_id: string
          user_stamp_id: string
        }
        Update: {
          created_at?: string
          id?: string
          rank?: number
          user_id?: string
          user_stamp_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_stamp_showcase_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stamp_showcase_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_stamp_showcase_user_stamp_id_fkey"
            columns: ["user_stamp_id"]
            isOneToOne: false
            referencedRelation: "user_stamps"
            referencedColumns: ["id"]
          },
        ]
      }
      user_stamps: {
        Row: {
          awarded_by_admin_id: string | null
          catalog_id: string | null
          city: string | null
          country: string | null
          created_at: string
          display_on_passport: boolean
          earned_at: string
          id: string
          is_revoked: boolean
          lat: number | null
          lng: number | null
          metadata: Json | null
          revoked_at: string | null
          revoked_reason: string | null
          source_id: string | null
          source_type: string | null
          stamp_definition_id: string
          title_override: string | null
          user_id: string
          visibility: string
        }
        Insert: {
          awarded_by_admin_id?: string | null
          catalog_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          display_on_passport?: boolean
          earned_at?: string
          id?: string
          is_revoked?: boolean
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          revoked_at?: string | null
          revoked_reason?: string | null
          source_id?: string | null
          source_type?: string | null
          stamp_definition_id: string
          title_override?: string | null
          user_id: string
          visibility?: string
        }
        Update: {
          awarded_by_admin_id?: string | null
          catalog_id?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          display_on_passport?: boolean
          earned_at?: string
          id?: string
          is_revoked?: boolean
          lat?: number | null
          lng?: number | null
          metadata?: Json | null
          revoked_at?: string | null
          revoked_reason?: string | null
          source_id?: string | null
          source_type?: string | null
          stamp_definition_id?: string
          title_override?: string | null
          user_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_stamps_awarded_by_admin_id_fkey"
            columns: ["awarded_by_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stamps_awarded_by_admin_id_fkey"
            columns: ["awarded_by_admin_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "user_stamps_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "universal_stamp_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stamps_stamp_definition_id_fkey"
            columns: ["stamp_definition_id"]
            isOneToOne: false
            referencedRelation: "stamp_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stamps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_stamps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_suggestion_seen: {
        Row: {
          expires_at: string
          seen_ids: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          expires_at: string
          seen_ids?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          expires_at?: string
          seen_ids?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_suggestion_seen_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_suggestion_seen_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      user_trust_scores: {
        Row: {
          score: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          score?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          score?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      viewer_creator_fatigue: {
        Row: {
          creator_id: string
          expires_at: string | null
          fatigue_score: number
          last_impression_at: string
          recent_impressions: number
          updated_at: string
          viewer_id: string
        }
        Insert: {
          creator_id: string
          expires_at?: string | null
          fatigue_score?: number
          last_impression_at?: string
          recent_impressions?: number
          updated_at?: string
          viewer_id: string
        }
        Update: {
          creator_id?: string
          expires_at?: string | null
          fatigue_score?: number
          last_impression_at?: string
          recent_impressions?: number
          updated_at?: string
          viewer_id?: string
        }
        Relationships: []
      }
      weather_cache: {
        Row: {
          brief_summary: string
          date_key: string
          destination: string
          fetched_at: string
          forecasts_json: Json
        }
        Insert: {
          brief_summary: string
          date_key: string
          destination: string
          fetched_at?: string
          forecasts_json?: Json
        }
        Update: {
          brief_summary?: string
          date_key?: string
          destination?: string
          fetched_at?: string
          forecasts_json?: Json
        }
        Relationships: []
      }
      wishlist_places: {
        Row: {
          id: string
          list_id: string
          place_data: Json
          place_id: string
          saved_at: string
          user_id: string
        }
        Insert: {
          id?: string
          list_id?: string
          place_data: Json
          place_id: string
          saved_at?: string
          user_id: string
        }
        Update: {
          id?: string
          list_id?: string
          place_data?: Json
          place_id?: string
          saved_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      buddy_availability: {
        Row: {
          buddy_id: string | null
          created_at: string | null
          date: string | null
          id: string | null
          is_available: boolean | null
          notes: string | null
          time_slots: string[] | null
        }
        Insert: {
          buddy_id?: string | null
          created_at?: string | null
          date?: string | null
          id?: string | null
          is_available?: boolean | null
          notes?: string | null
          time_slots?: string[] | null
        }
        Update: {
          buddy_id?: string | null
          created_at?: string | null
          date?: string | null
          id?: string | null
          is_available?: boolean | null
          notes?: string | null
          time_slots?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_availability_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_availability_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      buddy_booking_checkins: {
        Row: {
          booking_id: string | null
          checkin_type:
            | Database["public"]["Enums"]["rent_buddy_checkin_type"]
            | null
          created_at: string | null
          id: string | null
          response: string | null
          user_id: string | null
        }
        Insert: {
          booking_id?: string | null
          checkin_type?:
            | Database["public"]["Enums"]["rent_buddy_checkin_type"]
            | null
          created_at?: string | null
          id?: string | null
          response?: string | null
          user_id?: string | null
        }
        Update: {
          booking_id?: string | null
          checkin_type?:
            | Database["public"]["Enums"]["rent_buddy_checkin_type"]
            | null
          created_at?: string | null
          id?: string | null
          response?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_booking_requests: {
        Row: {
          booking_date: string | null
          buddy_id: string | null
          cancelled_at: string | null
          cash_balance_usd: number | null
          category: string | null
          city: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          deposit_usd: number | null
          duration_h: number | null
          group_size: number | null
          id: string | null
          notes: string | null
          package_id: string | null
          payment_mode:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time: string | null
          started_at: string | null
          status:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd: number | null
          traveler_id: string | null
          trip_id: string | null
          updated_at: string | null
        }
        Insert: {
          booking_date?: string | null
          buddy_id?: string | null
          cancelled_at?: string | null
          cash_balance_usd?: number | null
          category?: string | null
          city?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deposit_usd?: number | null
          duration_h?: number | null
          group_size?: number | null
          id?: string | null
          notes?: string | null
          package_id?: string | null
          payment_mode?:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status?:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time?: string | null
          started_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd?: number | null
          traveler_id?: string | null
          trip_id?: string | null
          updated_at?: string | null
        }
        Update: {
          booking_date?: string | null
          buddy_id?: string | null
          cancelled_at?: string | null
          cash_balance_usd?: number | null
          category?: string | null
          city?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deposit_usd?: number | null
          duration_h?: number | null
          group_size?: number | null
          id?: string | null
          notes?: string | null
          package_id?: string | null
          payment_mode?:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status?:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time?: string | null
          started_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd?: number | null
          traveler_id?: string | null
          trip_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_bookings: {
        Row: {
          booking_date: string | null
          buddy_id: string | null
          cancelled_at: string | null
          cash_balance_usd: number | null
          category: string | null
          city: string | null
          completed_at: string | null
          confirmed_at: string | null
          created_at: string | null
          deposit_usd: number | null
          duration_h: number | null
          group_size: number | null
          id: string | null
          notes: string | null
          package_id: string | null
          payment_mode:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time: string | null
          started_at: string | null
          status:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd: number | null
          traveler_id: string | null
          trip_id: string | null
          updated_at: string | null
        }
        Insert: {
          booking_date?: string | null
          buddy_id?: string | null
          cancelled_at?: string | null
          cash_balance_usd?: number | null
          category?: string | null
          city?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deposit_usd?: number | null
          duration_h?: number | null
          group_size?: number | null
          id?: string | null
          notes?: string | null
          package_id?: string | null
          payment_mode?:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status?:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time?: string | null
          started_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd?: number | null
          traveler_id?: string | null
          trip_id?: string | null
          updated_at?: string | null
        }
        Update: {
          booking_date?: string | null
          buddy_id?: string | null
          cancelled_at?: string | null
          cash_balance_usd?: number | null
          category?: string | null
          city?: string | null
          completed_at?: string | null
          confirmed_at?: string | null
          created_at?: string | null
          deposit_usd?: number | null
          duration_h?: number | null
          group_size?: number | null
          id?: string | null
          notes?: string | null
          package_id?: string | null
          payment_mode?:
            | Database["public"]["Enums"]["rent_buddy_payment_mode"]
            | null
          safety_status?:
            | Database["public"]["Enums"]["rent_buddy_safety_status"]
            | null
          start_time?: string | null
          started_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_booking_status"]
            | null
          total_usd?: number | null
          traveler_id?: string | null
          trip_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_traveler_id_fkey"
            columns: ["traveler_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_change_requests: {
        Row: {
          booking_id: string | null
          created_at: string | null
          id: string | null
          new_stops_json: Json | null
          old_stops_json: Json | null
          reason: string | null
          requested_by: string | null
          responded_at: string | null
          traveler_response: string | null
        }
        Insert: {
          booking_id?: string | null
          created_at?: string | null
          id?: string | null
          new_stops_json?: Json | null
          old_stops_json?: Json | null
          reason?: string | null
          requested_by?: string | null
          responded_at?: string | null
          traveler_response?: string | null
        }
        Update: {
          booking_id?: string | null
          created_at?: string | null
          id?: string | null
          new_stops_json?: Json | null
          old_stops_json?: Json | null
          reason?: string | null
          requested_by?: string | null
          responded_at?: string | null
          traveler_response?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_route_change_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_disputes: {
        Row: {
          booking_id: string | null
          created_at: string | null
          id: string | null
          raised_by: string | null
          reason:
            | Database["public"]["Enums"]["rent_buddy_dispute_reason"]
            | null
          resolution_note: string | null
          resolved_at: string | null
          status:
            | Database["public"]["Enums"]["rent_buddy_dispute_status"]
            | null
        }
        Insert: {
          booking_id?: string | null
          created_at?: string | null
          id?: string | null
          raised_by?: string | null
          reason?:
            | Database["public"]["Enums"]["rent_buddy_dispute_reason"]
            | null
          resolution_note?: string | null
          resolved_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_dispute_status"]
            | null
        }
        Update: {
          booking_id?: string | null
          created_at?: string | null
          id?: string | null
          raised_by?: string | null
          reason?:
            | Database["public"]["Enums"]["rent_buddy_dispute_reason"]
            | null
          resolution_note?: string | null
          resolved_at?: string | null
          status?:
            | Database["public"]["Enums"]["rent_buddy_dispute_status"]
            | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_disputes_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_favorites: {
        Row: {
          buddy_id: string | null
          created_at: string | null
          notes: string | null
          user_id: string | null
        }
        Insert: {
          buddy_id?: string | null
          created_at?: string | null
          notes?: string | null
          user_id?: string | null
        }
        Update: {
          buddy_id?: string | null
          created_at?: string | null
          notes?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_saved_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_saved_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_profiles: {
        Row: {
          admin_status: string | null
          average_rating: number | null
          bio: string | null
          buddy_level: string | null
          categories: string[] | null
          category_approvals: Json | null
          city: string | null
          completed_bookings: number | null
          country: string | null
          cover_photo_url: string | null
          created_at: string | null
          display_name: string | null
          gallery_urls: string[] | null
          hourly_rate_usd: number | null
          id: string | null
          intro_video_url: string | null
          languages: string[] | null
          max_group_size: number | null
          new_buddy_daytime_only: boolean | null
          new_buddy_max_hours: number | null
          new_buddy_public_only: boolean | null
          preferred_meetup_zones: string[] | null
          response_time_h: number | null
          review_count: number | null
          risk_hold: boolean | null
          safety_badges: string[] | null
          status: Database["public"]["Enums"]["rent_buddy_status"] | null
          tagline: string | null
          trust_score_override: number | null
          updated_at: string | null
          user_id: string | null
          verified: boolean | null
          verified_at: string | null
          vibe_tags: string[] | null
        }
        Insert: {
          admin_status?: string | null
          average_rating?: number | null
          bio?: string | null
          buddy_level?: string | null
          categories?: string[] | null
          category_approvals?: Json | null
          city?: string | null
          completed_bookings?: number | null
          country?: string | null
          cover_photo_url?: string | null
          created_at?: string | null
          display_name?: string | null
          gallery_urls?: string[] | null
          hourly_rate_usd?: number | null
          id?: string | null
          intro_video_url?: string | null
          languages?: string[] | null
          max_group_size?: number | null
          new_buddy_daytime_only?: boolean | null
          new_buddy_max_hours?: number | null
          new_buddy_public_only?: boolean | null
          preferred_meetup_zones?: string[] | null
          response_time_h?: number | null
          review_count?: number | null
          risk_hold?: boolean | null
          safety_badges?: string[] | null
          status?: Database["public"]["Enums"]["rent_buddy_status"] | null
          tagline?: string | null
          trust_score_override?: number | null
          updated_at?: string | null
          user_id?: string | null
          verified?: boolean | null
          verified_at?: string | null
          vibe_tags?: string[] | null
        }
        Update: {
          admin_status?: string | null
          average_rating?: number | null
          bio?: string | null
          buddy_level?: string | null
          categories?: string[] | null
          category_approvals?: Json | null
          city?: string | null
          completed_bookings?: number | null
          country?: string | null
          cover_photo_url?: string | null
          created_at?: string | null
          display_name?: string | null
          gallery_urls?: string[] | null
          hourly_rate_usd?: number | null
          id?: string | null
          intro_video_url?: string | null
          languages?: string[] | null
          max_group_size?: number | null
          new_buddy_daytime_only?: boolean | null
          new_buddy_max_hours?: number | null
          new_buddy_public_only?: boolean | null
          preferred_meetup_zones?: string[] | null
          response_time_h?: number | null
          review_count?: number | null
          risk_hold?: boolean | null
          safety_badges?: string[] | null
          status?: Database["public"]["Enums"]["rent_buddy_status"] | null
          tagline?: string | null
          trust_score_override?: number | null
          updated_at?: string | null
          user_id?: string | null
          verified?: boolean | null
          verified_at?: string | null
          vibe_tags?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      buddy_reviews: {
        Row: {
          blind_until: string | null
          body: string | null
          booking_id: string | null
          communication_score: number | null
          created_at: string | null
          id: string | null
          is_public: boolean | null
          photos: string[] | null
          punctuality_score: number | null
          rating: number | null
          reviewee_id: string | null
          reviewer_id: string | null
          role: string | null
          safety_score: number | null
          updated_at: string | null
        }
        Insert: {
          blind_until?: string | null
          body?: string | null
          booking_id?: string | null
          communication_score?: number | null
          created_at?: string | null
          id?: string | null
          is_public?: boolean | null
          photos?: string[] | null
          punctuality_score?: number | null
          rating?: number | null
          reviewee_id?: string | null
          reviewer_id?: string | null
          role?: string | null
          safety_score?: number | null
          updated_at?: string | null
        }
        Update: {
          blind_until?: string | null
          body?: string | null
          booking_id?: string | null
          communication_score?: number | null
          created_at?: string | null
          id?: string | null
          is_public?: boolean | null
          photos?: string[] | null
          punctuality_score?: number | null
          rating?: number | null
          reviewee_id?: string | null
          reviewer_id?: string | null
          role?: string | null
          safety_score?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewee_id_fkey"
            columns: ["reviewee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewee_id_fkey"
            columns: ["reviewee_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "public_profile_verification"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      public_profile_verification: {
        Row: {
          buddy_verified: boolean | null
          home_country_verified: boolean | null
          host_verified: boolean | null
          id_verified: boolean | null
          no_safety_flags: boolean | null
          profile_id: string | null
          selfie_matched: boolean | null
          verification_level: string | null
          verification_status: string | null
          verified_since: string | null
        }
        Insert: {
          buddy_verified?: never
          home_country_verified?: never
          host_verified?: never
          id_verified?: never
          no_safety_flags?: never
          profile_id?: string | null
          selfie_matched?: never
          verification_level?: string | null
          verification_status?: string | null
          verified_since?: string | null
        }
        Update: {
          buddy_verified?: never
          home_country_verified?: never
          host_verified?: never
          id_verified?: never
          no_safety_flags?: never
          profile_id?: string | null
          selfie_matched?: never
          verification_level?: string | null
          verification_status?: string | null
          verified_since?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      append_stamp_cleanup_error_paths: {
        Args: { p_error: string; p_job_id: string; p_paths: string[] }
        Returns: undefined
      }
      auth_uid_has_event_role: {
        Args: {
          eid: string
          roles: Database["public"]["Enums"]["event_role_type"][]
        }
        Returns: boolean
      }
      auth_uid_has_event_rsvp: {
        Args: {
          eid: string
          statuses: Database["public"]["Enums"]["event_rsvp_status"][]
        }
        Returns: boolean
      }
      auth_uid_is_event_cohost: { Args: { eid: string }; Returns: boolean }
      auth_uid_is_event_host: { Args: { eid: string }; Returns: boolean }
      can_post_to_trip: { Args: { t_id: string }; Returns: boolean }
      can_see_location: {
        Args: { target: string; viewer: string }
        Returns: boolean
      }
      can_see_post: { Args: { p_id: string }; Returns: boolean }
      can_see_postcard: { Args: { pc_id: string }; Returns: boolean }
      can_see_trip: { Args: { t_id: string }; Returns: boolean }
      claim_invite_link_slot: { Args: { link_id: string }; Returns: boolean }
      claim_invite_link_slot_for_user: {
        Args: { p_link_id: string; p_user_id: string }
        Returns: string
      }
      cleanup_stale_invite_link_attempts: {
        Args: never
        Returns: {
          claimed_at: string
          link_id: string
          trip_id: string
          user_id: string
        }[]
      }
      create_live_place_recap: {
        Args: {
          p_chapters?: Json
          p_moment_id: string
          p_owner_id: string
          p_place_day_id: string
          p_place_id: string
          p_place_snapshot: Json
          p_source_hash: string
          p_sources?: Json
          p_title: string
        }
        Returns: Json
      }
      decrement_discovery_place_saved_count: {
        Args: { p_id: string }
        Returns: number
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      event_is_in_state: {
        Args: {
          eid: string
          states: Database["public"]["Enums"]["event_state"][]
        }
        Returns: boolean
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      in_accepted_circle: {
        Args: { target: string; viewer: string }
        Returns: boolean
      }
      increment_bucket_count: {
        Args: {
          p_bucket: string
          p_canonical_place_id: string
          p_last_post_at: string
        }
        Returns: undefined
      }
      increment_counter: {
        Args: { column_name: string; row_id: string; table_name: string }
        Returns: undefined
      }
      increment_distribution_stats: {
        Args: {
          p_item_id: string
          p_negative_signal: boolean
          p_suppression_rate?: number
          p_threshold?: number
          p_viewer_id: string
        }
        Returns: undefined
      }
      increment_hashtag_usage_count: {
        Args: { p_hashtag_id: string }
        Returns: undefined
      }
      increment_stamp_progress: {
        Args: { p_definition_id: string; p_user_id: string }
        Returns: number
      }
      is_accepted_trip_member: { Args: { t_id: string }; Returns: boolean }
      is_blocked: { Args: { a: string; b: string }; Returns: boolean }
      longtransactionsenabled: { Args: never; Returns: boolean }
      places_within_radius: {
        Args: {
          p_lat: number
          p_limit?: number
          p_lng: number
          p_radius_m: number
        }
        Returns: {
          distance_m: number
          id: string
        }[]
      }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      purge_old_ranking_debug_samples: { Args: never; Returns: number }
      rb_adjust_buddy_counter: {
        Args: { p_buddy_id: string; p_column: string; p_delta: number }
        Returns: undefined
      }
      rb_sync_favorites_count: {
        Args: { p_buddy_id: string }
        Returns: undefined
      }
      recap_write_evidence: {
        Args: {
          p_chapters: Json
          p_place_id: string
          p_place_snapshot: Json
          p_sources: Json
          p_version_id: string
        }
        Returns: undefined
      }
      reconcile_invite_link_slots: {
        Args: { min_age_minutes?: number }
        Returns: {
          claimed_at: string
          link_id: string
          trip_id: string
          user_id: string
        }[]
      }
      regenerate_live_place_recap: {
        Args: {
          p_chapters?: Json
          p_owner_id: string
          p_place_snapshot: Json
          p_recap_id: string
          p_source_hash: string
          p_sources?: Json
        }
        Returns: Json
      }
      release_invite_link_slot: {
        Args: { link_id: string }
        Returns: undefined
      }
      shares_trip_with: { Args: { other: string }; Returns: boolean }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      toggle_feature_flag_with_audit: {
        Args: {
          p_changed_by_id: string
          p_flag: string
          p_new_enabled: boolean
        }
        Returns: {
          changed_at: string
          description: string
          enabled: boolean
          flag: string
          old_enabled: boolean
          updated_at: string
        }[]
      }
      transition_live_place_recap: {
        Args: { p_action: string; p_owner_id: string; p_recap_id: string }
        Returns: Json
      }
      unaccent: { Args: { "": string }; Returns: string }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      upsert_city_stamp: {
        Args: {
          p_label: string
          p_location_city: string
          p_location_country: string
          p_postcard_id: string
          p_sublabel: string
          p_user_id: string
        }
        Returns: undefined
      }
      upsert_hashtag_usage_and_increment: {
        Args: {
          p_author_id: string
          p_city?: string
          p_country?: string
          p_hashtag_id: string
          p_source_id: string
          p_source_type: string
        }
        Returns: boolean
      }
      user_is_event_participant: { Args: { eid: string }; Returns: boolean }
      user_locations_within_radius: {
        Args: {
          p_lat: number
          p_limit?: number
          p_lng: number
          p_radius_m: number
          p_since?: string
        }
        Returns: {
          distance_m: number
          user_id: string
        }[]
      }
      validate_live_place_recap_evidence: {
        Args: {
          p_chapters: Json
          p_moment_id: string
          p_owner_id: string
          p_place_day_id: string
          p_place_id: string
          p_place_snapshot: Json
          p_sources: Json
        }
        Returns: undefined
      }
      viewer_is_blocked: { Args: { target_id: string }; Returns: boolean }
    }
    Enums: {
      appeal_state: "submitted" | "under_review" | "approved" | "denied"
      appeal_target_type:
        | "post"
        | "memory"
        | "highlight"
        | "account_warning"
        | "trust_score_event"
        | "no_show"
        | "event"
        | "event_membership"
        | "trip"
        | "trip_membership"
        | "review"
      buddy_exception_type:
        | "blocked"
        | "time_blocked"
        | "vacation"
        | "available_only"
      checkpoint_status: "pending" | "arrived" | "skipped" | "cancelled"
      collection_entity_type:
        | "post"
        | "event"
        | "trip"
        | "memory"
        | "highlight"
        | "place"
        | "profile"
        | "hashtag"
      delayed_post_event_type:
        | "created_pending"
        | "exit_detected"
        | "published"
        | "canceled"
        | "privacy_changed"
        | "publish_without_location"
        | "geotag_credit_awarded"
        | "credit_rate_limited"
        | "worker_skipped"
      delayed_post_status:
        | "draft"
        | "private"
        | "pending_location_exit"
        | "pending_delay"
        | "pending_safety_review"
        | "published"
        | "canceled"
        | "expired"
      event_role_type: "host" | "co_host" | "moderator" | "banned"
      event_rsvp_status: "going" | "maybe" | "interested" | "cant_go"
      event_state:
        | "draft"
        | "open"
        | "full"
        | "waitlist"
        | "started"
        | "completed"
        | "cancelled"
        | "archived"
      event_visibility: "public" | "friends_only" | "invite_only"
      geo_zone_type: "circle" | "polygon" | "city" | "neighborhood" | "venue"
      geofence_trigger_type: "enter" | "exit" | "dwell"
      hidden_gem_sensitivity:
        | "public"
        | "approximate"
        | "reveal_after_save"
        | "reveal_after_acceptance"
        | "protected"
      hidden_gem_status: "pending" | "active" | "hidden" | "merged"
      hidden_gem_verification_level:
        | "unverified"
        | "community"
        | "guide"
        | "gps_verified"
        | "admin"
      location_mode_enum: "off" | "city_only" | "neighborhood" | "precise"
      location_sensitivity_level: "low" | "medium" | "high"
      location_session_type:
        | "manual"
        | "trip_arrival"
        | "plan_checkin"
        | "safe_return"
      location_source: "gps" | "manual" | "none"
      member_role: "owner" | "member" | "invited" | "co_host" | "viewer"
      portava_featured_category:
        | "best_video"
        | "best_hidden_gem"
        | "best_nightlife"
        | "best_restaurant"
        | "best_adventure"
        | "best_photo"
      post_location_privacy_mode:
        | "none"
        | "hidden"
        | "city_only"
        | "delayed_until_exit"
        | "delayed_until_time"
        | "trusted_circle_only"
      post_status: "active" | "hidden" | "reported" | "deleted"
      post_visibility: "public" | "trip_only" | "private" | "followers_only"
      pulse_geo_source: "gps" | "manual" | "inferred"
      pulse_geo_tag_type: "venue" | "neighborhood" | "city" | "custom"
      rb_support_category:
        | "buddy_no_show"
        | "traveler_no_show"
        | "cash_dispute"
        | "harassment"
        | "adult_service_violation"
        | "off_app_payment"
        | "route_changed"
        | "venue_scam"
        | "refund_request"
        | "fake_profile"
        | "emergency"
        | "other"
      rb_support_status: "open" | "in_review" | "resolved" | "closed"
      rb_tag_consent_status:
        | "pending"
        | "approved"
        | "declined"
        | "removed"
        | "auto_removed"
      rent_buddy_application_status:
        | "pending"
        | "under_review"
        | "approved"
        | "rejected"
      rent_buddy_beta_access_type: "invited" | "staff" | "influencer" | "tester"
      rent_buddy_beta_status: "active" | "revoked"
      rent_buddy_booking_status:
        | "pending"
        | "confirmed"
        | "in_progress"
        | "completed"
        | "cancelled"
        | "disputed"
        | "declined"
        | "expired"
        | "cancelled_by_traveler"
        | "cancelled_by_buddy"
        | "completed_pending_traveler_confirmation"
        | "scheduled"
        | "requested"
        | "no_show_pending"
      rent_buddy_change_request_status:
        | "pending"
        | "approved"
        | "declined"
        | "expired"
      rent_buddy_checkin_type:
        | "arrival"
        | "comfort_30min"
        | "check_ok"
        | "uncomfortable"
        | "end_early"
        | "contact_support"
        | "start_safe_return"
        | "emergency_phrase"
        | "arrived"
        | "started"
        | "could_not_find"
        | "no_show"
        | "unsafe"
        | "missed"
      rent_buddy_checklist_status:
        | "pending"
        | "in_progress"
        | "passed"
        | "failed"
      rent_buddy_city_status:
        | "disabled"
        | "waitlist_only"
        | "buddy_applications_open"
        | "internal_testing"
        | "beta_testing"
        | "public_mvp"
        | "paused"
        | "suspended"
      rent_buddy_dispute_reason:
        | "cash_balance_disagreement"
        | "no_show"
        | "harassment"
        | "policy_violation"
        | "route_violation"
        | "other"
      rent_buddy_dispute_status: "open" | "reviewing" | "resolved" | "closed"
      rent_buddy_flag_severity: "low" | "medium" | "high" | "critical"
      rent_buddy_flag_source:
        | "message"
        | "booking_note"
        | "profile"
        | "route_change"
        | "report"
        | "payment"
        | "review"
      rent_buddy_flag_status:
        | "open"
        | "reviewing"
        | "resolved"
        | "dismissed"
        | "escalated"
      rent_buddy_payment_mode: "full_in_app" | "deposit_plus_cash"
      rent_buddy_payment_status:
        | "not_required"
        | "pending"
        | "authorized"
        | "captured"
        | "partial"
        | "refunded"
        | "failed"
      rent_buddy_risk_status:
        | "normal"
        | "watch"
        | "limited"
        | "under_review"
        | "suspended"
      rent_buddy_safety_event_status: "open" | "reviewing" | "resolved"
      rent_buddy_safety_event_type:
        | "route_change_unapproved"
        | "comfort_check_distress"
        | "emergency_phrase_triggered"
        | "off_app_payment_attempt"
        | "feel_unsafe"
        | "end_early"
        | "no_show"
        | "harassment_reported"
        | "private_meetup_violation"
        | "unapproved_extra_guest"
        | "abandoned_booking"
        | "venue_scam_complaint"
        | "nightlife_unsafe_end"
      rent_buddy_safety_status:
        | "normal"
        | "check_requested"
        | "uncomfortable"
        | "emergency"
      rent_buddy_status:
        | "pending"
        | "active"
        | "paused"
        | "rejected"
        | "suspended"
      rent_buddy_verification_status:
        | "unverified"
        | "id_submitted"
        | "in_review"
        | "verified"
        | "rejected"
      review_entity_type: "trip" | "rent_buddy_booking" | "place"
      review_state: "published" | "hidden" | "removed"
      review_visibility: "public" | "anonymous"
      route_plan_status: "draft" | "active" | "completed" | "cancelled"
      route_style: "nightlife" | "scenic" | "foodie" | "low_walking" | "custom"
      stop_source_type:
        | "manual"
        | "place"
        | "meetup"
        | "hidden_gem"
        | "discovery"
        | "plan_item"
      story_state: "active" | "expired" | "saved" | "deleted" | "removed"
      story_visibility:
        | "public"
        | "friends_only"
        | "close_friends"
        | "trip_crew"
        | "circle_only"
        | "custom"
      tag_permission: "anyone" | "interacted" | "friends_only" | "nobody"
      tag_permission_level: "anyone" | "interacted" | "friends_only" | "nobody"
      thread_type_enum: "direct" | "trip" | "circle"
      translation_status: "pending" | "translated" | "failed" | "skipped"
      transport_mode: "walk" | "rideshare" | "transit" | "bike" | "drive"
      trip_status:
        | "draft"
        | "planning"
        | "upcoming"
        | "active"
        | "completed"
        | "cancelled"
        | "archived"
      trip_visibility: "public" | "buddies" | "private" | "invite"
      underexposure_status_enum:
        | "pending_evaluation"
        | "boosting"
        | "evaluated"
        | "suppressed"
      verification_method:
        | "gps_current_location"
        | "manual_only"
        | "gps_mismatch"
        | "unavailable"
      visibility_enum: "public" | "circle_only" | "trip_only" | "none"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      appeal_state: ["submitted", "under_review", "approved", "denied"],
      appeal_target_type: [
        "post",
        "memory",
        "highlight",
        "account_warning",
        "trust_score_event",
        "no_show",
        "event",
        "event_membership",
        "trip",
        "trip_membership",
        "review",
      ],
      buddy_exception_type: [
        "blocked",
        "time_blocked",
        "vacation",
        "available_only",
      ],
      checkpoint_status: ["pending", "arrived", "skipped", "cancelled"],
      collection_entity_type: [
        "post",
        "event",
        "trip",
        "memory",
        "highlight",
        "place",
        "profile",
        "hashtag",
      ],
      delayed_post_event_type: [
        "created_pending",
        "exit_detected",
        "published",
        "canceled",
        "privacy_changed",
        "publish_without_location",
        "geotag_credit_awarded",
        "credit_rate_limited",
        "worker_skipped",
      ],
      delayed_post_status: [
        "draft",
        "private",
        "pending_location_exit",
        "pending_delay",
        "pending_safety_review",
        "published",
        "canceled",
        "expired",
      ],
      event_role_type: ["host", "co_host", "moderator", "banned"],
      event_rsvp_status: ["going", "maybe", "interested", "cant_go"],
      event_state: [
        "draft",
        "open",
        "full",
        "waitlist",
        "started",
        "completed",
        "cancelled",
        "archived",
      ],
      event_visibility: ["public", "friends_only", "invite_only"],
      geo_zone_type: ["circle", "polygon", "city", "neighborhood", "venue"],
      geofence_trigger_type: ["enter", "exit", "dwell"],
      hidden_gem_sensitivity: [
        "public",
        "approximate",
        "reveal_after_save",
        "reveal_after_acceptance",
        "protected",
      ],
      hidden_gem_status: ["pending", "active", "hidden", "merged"],
      hidden_gem_verification_level: [
        "unverified",
        "community",
        "guide",
        "gps_verified",
        "admin",
      ],
      location_mode_enum: ["off", "city_only", "neighborhood", "precise"],
      location_sensitivity_level: ["low", "medium", "high"],
      location_session_type: [
        "manual",
        "trip_arrival",
        "plan_checkin",
        "safe_return",
      ],
      location_source: ["gps", "manual", "none"],
      member_role: ["owner", "member", "invited", "co_host", "viewer"],
      portava_featured_category: [
        "best_video",
        "best_hidden_gem",
        "best_nightlife",
        "best_restaurant",
        "best_adventure",
        "best_photo",
      ],
      post_location_privacy_mode: [
        "none",
        "hidden",
        "city_only",
        "delayed_until_exit",
        "delayed_until_time",
        "trusted_circle_only",
      ],
      post_status: ["active", "hidden", "reported", "deleted"],
      post_visibility: ["public", "trip_only", "private", "followers_only"],
      pulse_geo_source: ["gps", "manual", "inferred"],
      pulse_geo_tag_type: ["venue", "neighborhood", "city", "custom"],
      rb_support_category: [
        "buddy_no_show",
        "traveler_no_show",
        "cash_dispute",
        "harassment",
        "adult_service_violation",
        "off_app_payment",
        "route_changed",
        "venue_scam",
        "refund_request",
        "fake_profile",
        "emergency",
        "other",
      ],
      rb_support_status: ["open", "in_review", "resolved", "closed"],
      rb_tag_consent_status: [
        "pending",
        "approved",
        "declined",
        "removed",
        "auto_removed",
      ],
      rent_buddy_application_status: [
        "pending",
        "under_review",
        "approved",
        "rejected",
      ],
      rent_buddy_beta_access_type: ["invited", "staff", "influencer", "tester"],
      rent_buddy_beta_status: ["active", "revoked"],
      rent_buddy_booking_status: [
        "pending",
        "confirmed",
        "in_progress",
        "completed",
        "cancelled",
        "disputed",
        "declined",
        "expired",
        "cancelled_by_traveler",
        "cancelled_by_buddy",
        "completed_pending_traveler_confirmation",
        "scheduled",
        "requested",
        "no_show_pending",
      ],
      rent_buddy_change_request_status: [
        "pending",
        "approved",
        "declined",
        "expired",
      ],
      rent_buddy_checkin_type: [
        "arrival",
        "comfort_30min",
        "check_ok",
        "uncomfortable",
        "end_early",
        "contact_support",
        "start_safe_return",
        "emergency_phrase",
        "arrived",
        "started",
        "could_not_find",
        "no_show",
        "unsafe",
        "missed",
      ],
      rent_buddy_checklist_status: [
        "pending",
        "in_progress",
        "passed",
        "failed",
      ],
      rent_buddy_city_status: [
        "disabled",
        "waitlist_only",
        "buddy_applications_open",
        "internal_testing",
        "beta_testing",
        "public_mvp",
        "paused",
        "suspended",
      ],
      rent_buddy_dispute_reason: [
        "cash_balance_disagreement",
        "no_show",
        "harassment",
        "policy_violation",
        "route_violation",
        "other",
      ],
      rent_buddy_dispute_status: ["open", "reviewing", "resolved", "closed"],
      rent_buddy_flag_severity: ["low", "medium", "high", "critical"],
      rent_buddy_flag_source: [
        "message",
        "booking_note",
        "profile",
        "route_change",
        "report",
        "payment",
        "review",
      ],
      rent_buddy_flag_status: [
        "open",
        "reviewing",
        "resolved",
        "dismissed",
        "escalated",
      ],
      rent_buddy_payment_mode: ["full_in_app", "deposit_plus_cash"],
      rent_buddy_payment_status: [
        "not_required",
        "pending",
        "authorized",
        "captured",
        "partial",
        "refunded",
        "failed",
      ],
      rent_buddy_risk_status: [
        "normal",
        "watch",
        "limited",
        "under_review",
        "suspended",
      ],
      rent_buddy_safety_event_status: ["open", "reviewing", "resolved"],
      rent_buddy_safety_event_type: [
        "route_change_unapproved",
        "comfort_check_distress",
        "emergency_phrase_triggered",
        "off_app_payment_attempt",
        "feel_unsafe",
        "end_early",
        "no_show",
        "harassment_reported",
        "private_meetup_violation",
        "unapproved_extra_guest",
        "abandoned_booking",
        "venue_scam_complaint",
        "nightlife_unsafe_end",
      ],
      rent_buddy_safety_status: [
        "normal",
        "check_requested",
        "uncomfortable",
        "emergency",
      ],
      rent_buddy_status: [
        "pending",
        "active",
        "paused",
        "rejected",
        "suspended",
      ],
      rent_buddy_verification_status: [
        "unverified",
        "id_submitted",
        "in_review",
        "verified",
        "rejected",
      ],
      review_entity_type: ["trip", "rent_buddy_booking", "place"],
      review_state: ["published", "hidden", "removed"],
      review_visibility: ["public", "anonymous"],
      route_plan_status: ["draft", "active", "completed", "cancelled"],
      route_style: ["nightlife", "scenic", "foodie", "low_walking", "custom"],
      stop_source_type: [
        "manual",
        "place",
        "meetup",
        "hidden_gem",
        "discovery",
        "plan_item",
      ],
      story_state: ["active", "expired", "saved", "deleted", "removed"],
      story_visibility: [
        "public",
        "friends_only",
        "close_friends",
        "trip_crew",
        "circle_only",
        "custom",
      ],
      tag_permission: ["anyone", "interacted", "friends_only", "nobody"],
      tag_permission_level: ["anyone", "interacted", "friends_only", "nobody"],
      thread_type_enum: ["direct", "trip", "circle"],
      translation_status: ["pending", "translated", "failed", "skipped"],
      transport_mode: ["walk", "rideshare", "transit", "bike", "drive"],
      trip_status: [
        "draft",
        "planning",
        "upcoming",
        "active",
        "completed",
        "cancelled",
        "archived",
      ],
      trip_visibility: ["public", "buddies", "private", "invite"],
      underexposure_status_enum: [
        "pending_evaluation",
        "boosting",
        "evaluated",
        "suppressed",
      ],
      verification_method: [
        "gps_current_location",
        "manual_only",
        "gps_mismatch",
        "unavailable",
      ],
      visibility_enum: ["public", "circle_only", "trip_only", "none"],
    },
  },
} as const
