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
            foreignKeyName: "activity_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "availability_nudges_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "circle_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      circles: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "circles_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
      discovery_places: {
        Row: {
          blurb: string | null
          category: string | null
          city: string
          created_at: string
          id: string
          image_url: string | null
          lat: number | null
          lng: number | null
          name: string
          neighborhood: string | null
          note: string | null
          osm_id: string | null
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
          category?: string | null
          city?: string
          created_at?: string
          id?: string
          image_url?: string | null
          lat?: number | null
          lng?: number | null
          name: string
          neighborhood?: string | null
          note?: string | null
          osm_id?: string | null
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
          category?: string | null
          city?: string
          created_at?: string
          id?: string
          image_url?: string | null
          lat?: number | null
          lng?: number | null
          name?: string
          neighborhood?: string | null
          note?: string | null
          osm_id?: string | null
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
            foreignKeyName: "discovery_places_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "event_attendee_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "event_join_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          cover_url: string | null
          created_at: string
          description: string | null
          ends_at: string | null
          going_count: number
          host_id: string
          id: string
          is_recurring: boolean
          location_lat: number | null
          location_lng: number | null
          location_name: string | null
          max_attendees: number | null
          price_type: string | null
          price_url: string | null
          recurring_config: Json | null
          review_count: number
          rsvp_closed: boolean
          rsvp_options: string[]
          safety_notes: string | null
          show_exact_location: boolean
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
          cover_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          going_count?: number
          host_id: string
          id?: string
          is_recurring?: boolean
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          max_attendees?: number | null
          price_type?: string | null
          price_url?: string | null
          recurring_config?: Json | null
          review_count?: number
          rsvp_closed?: boolean
          rsvp_options?: string[]
          safety_notes?: string | null
          show_exact_location?: boolean
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
          cover_url?: string | null
          created_at?: string
          description?: string | null
          ends_at?: string | null
          going_count?: number
          host_id?: string
          id?: string
          is_recurring?: boolean
          location_lat?: number | null
          location_lng?: number | null
          location_name?: string | null
          max_attendees?: number | null
          price_type?: string | null
          price_url?: string | null
          recurring_config?: Json | null
          review_count?: number
          rsvp_closed?: boolean
          rsvp_options?: string[]
          safety_notes?: string | null
          show_exact_location?: boolean
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
      geo_zones: {
        Row: {
          center_lat: number | null
          center_lng: number | null
          city: string | null
          country_code: string | null
          created_at: string
          created_by: string | null
          id: string
          is_system: boolean
          metadata: Json | null
          name: string
          polygon_geojson: Json | null
          radius_meters: number | null
          zone_type: string
        }
        Insert: {
          center_lat?: number | null
          center_lng?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_system?: boolean
          metadata?: Json | null
          name: string
          polygon_geojson?: Json | null
          radius_meters?: number | null
          zone_type: string
        }
        Update: {
          center_lat?: number | null
          center_lng?: number | null
          city?: string | null
          country_code?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_system?: boolean
          metadata?: Json | null
          name?: string
          polygon_geojson?: Json | null
          radius_meters?: number | null
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
        ]
      }
      geofence_admin_settings: {
        Row: {
          default_radius_meters: number
          id: number
          max_radius_meters: number
          min_radius_meters: number
          updated_at: string
        }
        Insert: {
          default_radius_meters?: number
          id?: number
          max_radius_meters?: number
          min_radius_meters?: number
          updated_at?: string
        }
        Update: {
          default_radius_meters?: number
          id?: number
          max_radius_meters?: number
          min_radius_meters?: number
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
        ]
      }
      highlights: {
        Row: {
          archived_at: string | null
          caption: string | null
          created_at: string
          deleted_at: string | null
          expires_at: string
          id: string
          location_city: string | null
          location_country: string | null
          location_name: string | null
          media_type: string
          media_url: string
          owner_id: string
          video_duration_seconds: number | null
          visibility: string
        }
        Insert: {
          archived_at?: string | null
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          expires_at: string
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          media_type: string
          media_url: string
          owner_id: string
          video_duration_seconds?: number | null
          visibility?: string
        }
        Update: {
          archived_at?: string | null
          caption?: string | null
          created_at?: string
          deleted_at?: string | null
          expires_at?: string
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          media_type?: string
          media_url?: string
          owner_id?: string
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
        ]
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
        ]
      }
      location_sessions: {
        Row: {
          ended_at: string | null
          id: string
          metadata: Json | null
          plan_item_id: string | null
          resolved_city: string | null
          resolved_country: string | null
          session_type: string
          started_at: string
          trip_id: string | null
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          metadata?: Json | null
          plan_item_id?: string | null
          resolved_city?: string | null
          resolved_country?: string | null
          session_type: string
          started_at?: string
          trip_id?: string | null
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          metadata?: Json | null
          plan_item_id?: string | null
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
        ]
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
            foreignKeyName: "map_pins_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
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
        ]
      }
      meetups: {
        Row: {
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
          starts_at: string | null
          status: string
          time_block: string | null
          title: string
          trip_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
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
          starts_at?: string | null
          status?: string
          time_block?: string | null
          title: string
          trip_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
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
            foreignKeyName: "meetups_creator_id_fkey"
            columns: ["creator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
      message_requests: {
        Row: {
          created_at: string
          id: string
          preview_text: string | null
          recipient_id: string
          responded_at: string | null
          sender_id: string
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          preview_text?: string | null
          recipient_id: string
          responded_at?: string | null
          sender_id: string
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          preview_text?: string | null
          recipient_id?: string
          responded_at?: string | null
          sender_id?: string
          status?: string
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
            foreignKeyName: "message_requests_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
        ]
      }
      message_threads: {
        Row: {
          circle_owner_id: string | null
          created_at: string
          id: string
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
          id?: string
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
          id?: string
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
        ]
      }
      messages: {
        Row: {
          body: string
          created_at: string
          deleted_at: string | null
          edited_at: string | null
          id: string
          language_detection_source: string | null
          msg_type: string
          original_language: string | null
          sender_id: string
          sender_original_language: string | null
          subtype: string | null
          thread_id: string
          translated_body_json: Json | null
        }
        Insert: {
          body: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          language_detection_source?: string | null
          msg_type?: string
          original_language?: string | null
          sender_id: string
          sender_original_language?: string | null
          subtype?: string | null
          thread_id: string
          translated_body_json?: Json | null
        }
        Update: {
          body?: string
          created_at?: string
          deleted_at?: string | null
          edited_at?: string | null
          id?: string
          language_detection_source?: string | null
          msg_type?: string
          original_language?: string | null
          sender_id?: string
          sender_original_language?: string | null
          subtype?: string | null
          thread_id?: string
          translated_body_json?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          performed_by: string | null
          reason: string | null
          target_user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          performed_by?: string | null
          reason?: string | null
          target_user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
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
            foreignKeyName: "moderation_actions_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_contribution_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_contribution_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_memories: {
        Row: {
          body: string | null
          created_at: string
          id: string
          metadata: Json | null
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          status?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_memories_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_postcards: {
        Row: {
          caption: string | null
          created_at: string
          deleted_at: string | null
          id: string
          location_city: string | null
          location_country: string | null
          location_name: string | null
          location_verified: boolean
          media_url: string
          post_id: string
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
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          location_verified?: boolean
          media_url: string
          post_id: string
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
          id?: string
          location_city?: string | null
          location_country?: string | null
          location_name?: string | null
          location_verified?: boolean
          media_url?: string
          post_id?: string
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
            foreignKeyName: "passport_postcards_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      passport_stamps: {
        Row: {
          awarded_at: string
          city: string | null
          country: string | null
          created_at: string
          id: string
          stamp_type: string
          user_id: string
        }
        Insert: {
          awarded_at?: string
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          stamp_type: string
          user_id: string
        }
        Update: {
          awarded_at?: string
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          stamp_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passport_stamps_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          map_visible: string
          memories_visible: string
          stamps_visible: string
          updated_at: string
          user_id: string
        }
        Insert: {
          map_visible?: string
          memories_visible?: string
          stamps_visible?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          map_visible?: string
          memories_visible?: string
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
        ]
      }
      plan_attendance_events: {
        Row: {
          created_at: string
          details: Json | null
          event_type: string
          id: string
          plan_geofence_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          plan_geofence_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          plan_geofence_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_attendance_events_plan_geofence_id_fkey"
            columns: ["plan_geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_attendance_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_checkins: {
        Row: {
          checked_in_at: string | null
          id: string
          plan_geofence_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          checked_in_at?: string | null
          id?: string
          plan_geofence_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          checked_in_at?: string | null
          id?: string
          plan_geofence_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "plan_checkins_plan_geofence_id_fkey"
            columns: ["plan_geofence_id"]
            isOneToOne: false
            referencedRelation: "plan_geofences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_checkins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          arrival_status_visible: boolean
          check_in_required: boolean
          city: string | null
          created_at: string
          exact_visibility: string | null
          host_revealed: boolean
          id: string
          last_triggered_at: string | null
          location_name: string | null
          message_template: string | null
          neighborhood: string | null
          no_show_affects_reliability: boolean
          notify_members: boolean
          plan_item_id: string | null
          public_preview_level: string | null
          trigger_type: string
          trip_id: string
          venue_name: string | null
          window_end: string | null
          window_start: string | null
          zone_id: string | null
        }
        Insert: {
          arrival_status_visible?: boolean
          check_in_required?: boolean
          city?: string | null
          created_at?: string
          exact_visibility?: string | null
          host_revealed?: boolean
          id?: string
          last_triggered_at?: string | null
          location_name?: string | null
          message_template?: string | null
          neighborhood?: string | null
          no_show_affects_reliability?: boolean
          notify_members?: boolean
          plan_item_id?: string | null
          public_preview_level?: string | null
          trigger_type?: string
          trip_id: string
          venue_name?: string | null
          window_end?: string | null
          window_start?: string | null
          zone_id?: string | null
        }
        Update: {
          arrival_status_visible?: boolean
          check_in_required?: boolean
          city?: string | null
          created_at?: string
          exact_visibility?: string | null
          host_revealed?: boolean
          id?: string
          last_triggered_at?: string | null
          location_name?: string | null
          message_template?: string | null
          neighborhood?: string | null
          no_show_affects_reliability?: boolean
          notify_members?: boolean
          plan_item_id?: string | null
          public_preview_level?: string | null
          trigger_type?: string
          trip_id?: string
          venue_name?: string | null
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
          author_id: string
          category: string | null
          comment_count: number
          comments_setting: string
          content: string
          created_at: string
          created_by: string | null
          delayed_location_reason: string | null
          deleted_at: string | null
          exited_geofence_at: string | null
          geofence_radius_meters: number
          geotag_credit_awarded: boolean
          geotag_verified: boolean
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
          media_type: string | null
          media_urls: string[]
          original_lat: number | null
          original_lng: number | null
          post_status: Database["public"]["Enums"]["delayed_post_status"]
          public_lat: number | null
          public_lng: number | null
          public_location_label: string | null
          publish_after_exit: boolean
          publish_after_time: string | null
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
          author_id: string
          category?: string | null
          comment_count?: number
          comments_setting?: string
          content?: string
          created_at?: string
          created_by?: string | null
          delayed_location_reason?: string | null
          deleted_at?: string | null
          exited_geofence_at?: string | null
          geofence_radius_meters?: number
          geotag_credit_awarded?: boolean
          geotag_verified?: boolean
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
          media_type?: string | null
          media_urls?: string[]
          original_lat?: number | null
          original_lng?: number | null
          post_status?: Database["public"]["Enums"]["delayed_post_status"]
          public_lat?: number | null
          public_lng?: number | null
          public_location_label?: string | null
          publish_after_exit?: boolean
          publish_after_time?: string | null
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
          author_id?: string
          category?: string | null
          comment_count?: number
          comments_setting?: string
          content?: string
          created_at?: string
          created_by?: string | null
          delayed_location_reason?: string | null
          deleted_at?: string | null
          exited_geofence_at?: string | null
          geofence_radius_meters?: number
          geotag_credit_awarded?: boolean
          geotag_verified?: boolean
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
          media_type?: string | null
          media_urls?: string[]
          original_lat?: number | null
          original_lng?: number | null
          post_status?: Database["public"]["Enums"]["delayed_post_status"]
          public_lat?: number | null
          public_lng?: number | null
          public_location_label?: string | null
          publish_after_exit?: boolean
          publish_after_time?: string | null
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
            foreignKeyName: "posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
        ]
      }
      posts_comments: {
        Row: {
          body: string
          created_at: string
          deleted_at: string | null
          id: string
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
      profiles: {
        Row: {
          account_status: string
          auto_translate_messages: boolean
          availability_tags: string[] | null
          avatar_url: string | null
          bio: string | null
          budget_style: string | null
          comfort_level: string | null
          cover_photo_url: string | null
          created_at: string
          current_city: string | null
          date_of_birth: string | null
          default_language: string | null
          display_name: string | null
          dob_verified: boolean
          expo_push_token: string | null
          handle: string
          highlights_last_viewed_at: string | null
          home_city: string | null
          home_country: string | null
          id: string
          interests: string[]
          is_private: boolean
          looking_for: string[] | null
          name: string
          notifications_inbox_viewed_at: string | null
          open_to_meet: boolean
          passport_visibility: string
          planning_style: string | null
          preferred_language: string | null
          preferred_message_language: string
          public_social_links: Json | null
          role: string
          show_original_messages: boolean
          show_telegraph_circle: boolean
          show_telegraph_dm: boolean
          show_telegraph_trip: boolean
          spoken_languages: string[] | null
          tag_permission: Database["public"]["Enums"]["tag_permission_level"]
          translation_updated_at: string | null
          travel_group_style: string[] | null
          travel_pace: string | null
          travel_style: string | null
          travel_styles: string[] | null
          updated_at: string
          updated_by: string | null
          username: string | null
          username_updated_at: string | null
          verification_expires_at: string | null
          verification_method: string | null
          verification_status: string
          verified: boolean
          verified_at: string | null
        }
        Insert: {
          account_status?: string
          auto_translate_messages?: boolean
          availability_tags?: string[] | null
          avatar_url?: string | null
          bio?: string | null
          budget_style?: string | null
          comfort_level?: string | null
          cover_photo_url?: string | null
          created_at?: string
          current_city?: string | null
          date_of_birth?: string | null
          default_language?: string | null
          display_name?: string | null
          dob_verified?: boolean
          expo_push_token?: string | null
          handle: string
          highlights_last_viewed_at?: string | null
          home_city?: string | null
          home_country?: string | null
          id: string
          interests?: string[]
          is_private?: boolean
          looking_for?: string[] | null
          name: string
          notifications_inbox_viewed_at?: string | null
          open_to_meet?: boolean
          passport_visibility?: string
          planning_style?: string | null
          preferred_language?: string | null
          preferred_message_language?: string
          public_social_links?: Json | null
          role?: string
          show_original_messages?: boolean
          show_telegraph_circle?: boolean
          show_telegraph_dm?: boolean
          show_telegraph_trip?: boolean
          spoken_languages?: string[] | null
          tag_permission?: Database["public"]["Enums"]["tag_permission_level"]
          translation_updated_at?: string | null
          travel_group_style?: string[] | null
          travel_pace?: string | null
          travel_style?: string | null
          travel_styles?: string[] | null
          updated_at?: string
          updated_by?: string | null
          username?: string | null
          username_updated_at?: string | null
          verification_expires_at?: string | null
          verification_method?: string | null
          verification_status?: string
          verified?: boolean
          verified_at?: string | null
        }
        Update: {
          account_status?: string
          auto_translate_messages?: boolean
          availability_tags?: string[] | null
          avatar_url?: string | null
          bio?: string | null
          budget_style?: string | null
          comfort_level?: string | null
          cover_photo_url?: string | null
          created_at?: string
          current_city?: string | null
          date_of_birth?: string | null
          default_language?: string | null
          display_name?: string | null
          dob_verified?: boolean
          expo_push_token?: string | null
          handle?: string
          highlights_last_viewed_at?: string | null
          home_city?: string | null
          home_country?: string | null
          id?: string
          interests?: string[]
          is_private?: boolean
          looking_for?: string[] | null
          name?: string
          notifications_inbox_viewed_at?: string | null
          open_to_meet?: boolean
          passport_visibility?: string
          planning_style?: string | null
          preferred_language?: string | null
          preferred_message_language?: string
          public_social_links?: Json | null
          role?: string
          show_original_messages?: boolean
          show_telegraph_circle?: boolean
          show_telegraph_dm?: boolean
          show_telegraph_trip?: boolean
          spoken_languages?: string[] | null
          tag_permission?: Database["public"]["Enums"]["tag_permission_level"]
          translation_updated_at?: string | null
          travel_group_style?: string[] | null
          travel_pace?: string | null
          travel_style?: string | null
          travel_styles?: string[] | null
          updated_at?: string
          updated_by?: string | null
          username?: string | null
          username_updated_at?: string | null
          verification_expires_at?: string | null
          verification_method?: string | null
          verification_status?: string
          verified?: boolean
          verified_at?: string | null
        }
        Relationships: []
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
        ]
      }
      rent_buddy_addons: {
        Row: {
          buddy_id: string
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          price: number
        }
        Insert: {
          buddy_id: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          price: number
        }
        Update: {
          buddy_id?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          price?: number
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_addons_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
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
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
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
        ]
      }
      rent_buddy_applications: {
        Row: {
          applicant_id: string
          bio: string | null
          cities: string[] | null
          id: string
          languages: string[] | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string
        }
        Insert: {
          applicant_id: string
          bio?: string | null
          cities?: string[] | null
          id?: string
          languages?: string[] | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
        }
        Update: {
          applicant_id?: string
          bio?: string | null
          cities?: string[] | null
          id?: string
          languages?: string[] | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_applications_applicant_id_fkey"
            columns: ["applicant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_applications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_availability: {
        Row: {
          buddy_id: string
          city: string
          created_at: string
          date_from: string
          date_to: string
          id: string
          is_blocked: boolean
          note: string | null
        }
        Insert: {
          buddy_id: string
          city: string
          created_at?: string
          date_from: string
          date_to: string
          id?: string
          is_blocked?: boolean
          note?: string | null
        }
        Update: {
          buddy_id?: string
          city?: string
          created_at?: string
          date_from?: string
          date_to?: string
          id?: string
          is_blocked?: boolean
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_availability_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_booking_extensions: {
        Row: {
          booking_id: string
          created_at: string
          extra_days: number
          extra_price: number | null
          id: string
          requested_by: string
          status: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          extra_days: number
          extra_price?: number | null
          id?: string
          requested_by: string
          status?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          extra_days?: number
          extra_price?: number | null
          id?: string
          requested_by?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_booking_extensions_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_booking_extensions_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_bookings: {
        Row: {
          buddy_id: string
          cancel_reason: string | null
          cancelled_by: string | null
          city: string
          created_at: string
          currency: string
          date_from: string
          date_to: string
          id: string
          note: string | null
          package_id: string | null
          status: string
          stay_connected_buddy: boolean
          stay_connected_traveler: boolean
          total_price: number | null
          traveler_id: string
          updated_at: string
        }
        Insert: {
          buddy_id: string
          cancel_reason?: string | null
          cancelled_by?: string | null
          city: string
          created_at?: string
          currency?: string
          date_from: string
          date_to: string
          id?: string
          note?: string | null
          package_id?: string | null
          status?: string
          stay_connected_buddy?: boolean
          stay_connected_traveler?: boolean
          total_price?: number | null
          traveler_id: string
          updated_at?: string
        }
        Update: {
          buddy_id?: string
          cancel_reason?: string | null
          cancelled_by?: string | null
          city?: string
          created_at?: string
          currency?: string
          date_from?: string
          date_to?: string
          id?: string
          note?: string | null
          package_id?: string | null
          status?: string
          stay_connected_buddy?: boolean
          stay_connected_traveler?: boolean
          total_price?: number | null
          traveler_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_bookings_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_bookings_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
        ]
      }
      rent_buddy_city_rollouts: {
        Row: {
          city: string
          created_at: string | null
          id: string
          notes: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          city: string
          created_at?: string | null
          id?: string
          notes?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          city?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      rent_buddy_disputes: {
        Row: {
          booking_id: string
          created_at: string
          id: string
          raised_by: string
          reason: string
          resolution: string | null
          resolved_at: string | null
          status: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          id?: string
          raised_by: string
          reason: string
          resolution?: string | null
          resolved_at?: string | null
          status?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          id?: string
          raised_by?: string
          reason?: string
          resolution?: string | null
          resolved_at?: string | null
          status?: string
        }
        Relationships: [
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
        ]
      }
      rent_buddy_emergency_contacts_snapshot: {
        Row: {
          booking_id: string
          captured_at: string
          contacts: Json
          id: string
          user_id: string
        }
        Insert: {
          booking_id: string
          captured_at?: string
          contacts?: Json
          id?: string
          user_id: string
        }
        Update: {
          booking_id?: string
          captured_at?: string
          contacts?: Json
          id?: string
          user_id?: string
        }
        Relationships: [
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
        ]
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
        }
        Relationships: []
      }
      rent_buddy_fee_rules: {
        Row: {
          buddy_level: string
          description: string | null
          platform_fee_percent: number
          traveler_service_fee_pct: number
          traveler_service_fee_usd: number
        }
        Insert: {
          buddy_level: string
          description?: string | null
          platform_fee_percent: number
          traveler_service_fee_pct: number
          traveler_service_fee_usd: number
        }
        Update: {
          buddy_level?: string
          description?: string | null
          platform_fee_percent?: number
          traveler_service_fee_pct?: number
          traveler_service_fee_usd?: number
        }
        Relationships: []
      }
      rent_buddy_packages: {
        Row: {
          admin_review_status: string | null
          buddy_id: string
          category: string | null
          city: string | null
          created_at: string
          currency: string
          description: string | null
          duration_h: number | null
          duration_hours: number | null
          id: string
          is_active: boolean
          max_group: number | null
          name: string
          price: number
          price_usd: number | null
          title: string | null
        }
        Insert: {
          admin_review_status?: string | null
          buddy_id: string
          category?: string | null
          city?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          duration_h?: number | null
          duration_hours?: number | null
          id?: string
          is_active?: boolean
          max_group?: number | null
          name: string
          price: number
          price_usd?: number | null
          title?: string | null
        }
        Update: {
          admin_review_status?: string | null
          buddy_id?: string
          category?: string | null
          city?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          duration_h?: number | null
          duration_hours?: number | null
          id?: string
          is_active?: boolean
          max_group?: number | null
          name?: string
          price?: number
          price_usd?: number | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_packages_buddy_id_fkey"
            columns: ["buddy_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_policy_flags: {
        Row: {
          details: Json | null
          flag_type: string
          flagged_at: string
          id: string
          resolved: boolean
          resolved_at: string | null
          user_id: string
        }
        Insert: {
          details?: Json | null
          flag_type: string
          flagged_at?: string
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          user_id: string
        }
        Update: {
          details?: Json | null
          flag_type?: string
          flagged_at?: string
          id?: string
          resolved?: boolean
          resolved_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_policy_flags_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_profiles: {
        Row: {
          avg_rating: number | null
          bio: string | null
          cities: string[]
          created_at: string
          currency: string
          daily_rate: number | null
          hourly_rate: number | null
          id: string
          is_active: boolean
          is_verified: boolean
          languages: string[]
          review_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_rating?: number | null
          bio?: string | null
          cities?: string[]
          created_at?: string
          currency?: string
          daily_rate?: number | null
          hourly_rate?: number | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          languages?: string[]
          review_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          avg_rating?: number | null
          bio?: string | null
          cities?: string[]
          created_at?: string
          currency?: string
          daily_rate?: number | null
          hourly_rate?: number | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          languages?: string[]
          review_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_reviews: {
        Row: {
          body: string | null
          booking_id: string
          created_at: string
          id: string
          is_public: boolean
          rating: number
          reviewee_id: string
          reviewer_id: string
        }
        Insert: {
          body?: string | null
          booking_id: string
          created_at?: string
          id?: string
          is_public?: boolean
          rating: number
          reviewee_id: string
          reviewer_id: string
        }
        Update: {
          body?: string | null
          booking_id?: string
          created_at?: string
          id?: string
          is_public?: boolean
          rating?: number
          reviewee_id?: string
          reviewer_id?: string
        }
        Relationships: [
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
            foreignKeyName: "rent_buddy_reviews_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_route_change_requests: {
        Row: {
          booking_id: string
          created_at: string
          description: string
          id: string
          requested_by: string
          status: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          description: string
          id?: string
          requested_by: string
          status?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          description?: string
          id?: string
          requested_by?: string
          status?: string
        }
        Relationships: [
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
          location: string
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
          location: string
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
          location?: string
          notes?: string | null
          stop_order?: number
        }
        Relationships: [
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
          checked_at: string
          id: string
          lat: number | null
          lng: number | null
          note: string | null
          status: string
          user_id: string
        }
        Insert: {
          booking_id: string
          checked_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          note?: string | null
          status?: string
          user_id: string
        }
        Update: {
          booking_id?: string
          checked_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          note?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
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
        ]
      }
      rent_buddy_safety_events: {
        Row: {
          booking_id: string
          created_at: string
          description: string | null
          event_type: string
          id: string
          reported_by: string
          resolved: boolean
          severity: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          description?: string | null
          event_type: string
          id?: string
          reported_by: string
          resolved?: boolean
          severity?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          description?: string | null
          event_type?: string
          id?: string
          reported_by?: string
          resolved?: boolean
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_safety_events_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "rent_buddy_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_buddy_safety_events_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_saved: {
        Row: {
          buddy_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          buddy_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          buddy_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
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
        ]
      }
      rent_buddy_user_limits: {
        Row: {
          max_active_bookings: number
          max_pending_requests: number
          updated_at: string
          user_id: string
        }
        Insert: {
          max_active_bookings?: number
          max_pending_requests?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          max_active_bookings?: number
          max_pending_requests?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_buddy_user_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rent_buddy_waitlist: {
        Row: {
          city: string
          created_at: string
          date_from: string | null
          date_to: string | null
          id: string
          note: string | null
          user_id: string
        }
        Insert: {
          city: string
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          id?: string
          note?: string | null
          user_id: string
        }
        Update: {
          city?: string
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          id?: string
          note?: string | null
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
            foreignKeyName: "reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
          ends_at: string | null
          icon_url: string | null
          id: string
          is_active: boolean
          is_repeatable: boolean
          level_config: Json | null
          max_awards_per_user: number | null
          name: string
          rarity: string
          slug: string
          source_system: string | null
          stamp_type: string
          starts_at: string | null
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
          ends_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_repeatable?: boolean
          level_config?: Json | null
          max_awards_per_user?: number | null
          name: string
          rarity?: string
          slug: string
          source_system?: string | null
          stamp_type: string
          starts_at?: string | null
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
          ends_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_repeatable?: boolean
          level_config?: Json | null
          max_awards_per_user?: number | null
          name?: string
          rarity?: string
          slug?: string
          source_system?: string | null
          stamp_type?: string
          starts_at?: string | null
          updated_at?: string
          visibility_default?: string
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
            foreignKeyName: "tags_tagger_id_fkey"
            columns: ["tagger_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
        ]
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
            foreignKeyName: "trip_activity_log_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
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
        ]
      }
      trip_crew_location_preferences: {
        Row: {
          created_at: string
          ghost_mode_enabled: boolean
          id: string
          trip_id: string
          updated_at: string
          user_id: string
          visibility_default: string
        }
        Insert: {
          created_at?: string
          ghost_mode_enabled?: boolean
          id?: string
          trip_id: string
          updated_at?: string
          user_id: string
          visibility_default?: string
        }
        Update: {
          created_at?: string
          ghost_mode_enabled?: boolean
          id?: string
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
        ]
      }
      trip_crew_location_sessions: {
        Row: {
          allowed_member_ids: string[] | null
          created_at: string
          ended_at: string | null
          expires_at: string
          id: string
          trip_id: string
          user_id: string
        }
        Insert: {
          allowed_member_ids?: string[] | null
          created_at?: string
          ended_at?: string | null
          expires_at: string
          id?: string
          trip_id: string
          user_id: string
        }
        Update: {
          allowed_member_ids?: string[] | null
          created_at?: string
          ended_at?: string | null
          expires_at?: string
          id?: string
          trip_id?: string
          user_id?: string
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
            foreignKeyName: "trip_documents_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
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
        ]
      }
      trip_members: {
        Row: {
          created_at: string
          joined_at: string | null
          permissions: Json | null
          role: Database["public"]["Enums"]["member_role"]
          status: string
          trip_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          joined_at?: string | null
          permissions?: Json | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: string
          trip_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          joined_at?: string | null
          permissions?: Json | null
          role?: Database["public"]["Enums"]["member_role"]
          status?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
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
          category: string
          created_at: string
          creator_id: string
          day_date: string | null
          ends_at: string | null
          id: string
          lat: number | null
          lng: number | null
          location_is_private: boolean
          location_name: string | null
          notes: string | null
          removed_at: string | null
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
          category?: string
          created_at?: string
          creator_id: string
          day_date?: string | null
          ends_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          location_is_private?: boolean
          location_name?: string | null
          notes?: string | null
          removed_at?: string | null
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
          category?: string
          created_at?: string
          creator_id?: string
          day_date?: string | null
          ends_at?: string | null
          id?: string
          lat?: number | null
          lng?: number | null
          location_is_private?: boolean
          location_name?: string | null
          notes?: string | null
          removed_at?: string | null
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
            foreignKeyName: "trip_plan_items_trip_id_fkey"
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
        ]
      }
      trips: {
        Row: {
          allow_friend_suggestions: boolean
          allow_join_requests: boolean
          allow_trip_crew_invites: boolean
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
          owner_id: string
          plan_edit_permission: string
          precise_location_visible: boolean
          progress: number
          show_destination_city: boolean
          show_exact_dates: boolean
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
          owner_id: string
          plan_edit_permission?: string
          precise_location_visible?: boolean
          progress?: number
          show_destination_city?: boolean
          show_exact_dates?: boolean
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
          owner_id?: string
          plan_edit_permission?: string
          precise_location_visible?: boolean
          progress?: number
          show_destination_city?: boolean
          show_exact_dates?: boolean
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
        ]
      }
      universal_stamp_catalog: {
        Row: {
          active_version_id: string | null
          canonical_location_key: string
          city: string | null
          country: string
          country_code: string | null
          created_at: string
          earn_count: number
          id: string
          lat: number | null
          lng: number | null
          neighborhood: string | null
          place_ids: Json
          prompt_template_version: string
          region: string | null
          stamp_type: string
          status: string
          display_name: string
          updated_at: string
        }
        Insert: {
          active_version_id?: string | null
          canonical_location_key: string
          city?: string | null
          country: string
          country_code?: string | null
          created_at?: string
          earn_count?: number
          id?: string
          lat?: number | null
          lng?: number | null
          neighborhood?: string | null
          place_ids?: Json
          prompt_template_version?: string
          region?: string | null
          stamp_type: string
          status?: string
          display_name: string
          updated_at?: string
        }
        Update: {
          active_version_id?: string | null
          canonical_location_key?: string
          city?: string | null
          country?: string
          country_code?: string | null
          created_at?: string
          earn_count?: number
          id?: string
          lat?: number | null
          lng?: number | null
          neighborhood?: string | null
          place_ids?: Json
          prompt_template_version?: string
          region?: string | null
          stamp_type?: string
          status?: string
          display_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stamp_artwork_versions_catalog_id_fkey"
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
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
          set_by?: string | null
          state: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          reason?: string | null
          set_by?: string | null
          state?: string
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
            foreignKeyName: "user_account_states_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
        ]
      }
      user_deletion_requests: {
        Row: {
          cancelled_at: string | null
          executed_at: string | null
          requested_at: string
          scheduled_at: string
          status: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          executed_at?: string | null
          requested_at?: string
          scheduled_at: string
          status?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          executed_at?: string | null
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
            foreignKeyName: "user_follows_following_id_fkey"
            columns: ["following_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "user_interaction_cooldowns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "user_mutes_muter_id_fkey"
            columns: ["muter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
        ]
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
            foreignKeyName: "user_restrictions_restrictor_id_fkey"
            columns: ["restrictor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
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
            foreignKeyName: "user_saves_saver_id_fkey"
            columns: ["saver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_stamps: {
        Row: {
          awarded_by_admin_id: string | null
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
        ]
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
      [_ in never]: never
    }
    Functions: {
      can_post_to_trip: { Args: { t_id: string }; Returns: boolean }
      can_see_location: {
        Args: { target: string; viewer: string }
        Returns: boolean
      }
      can_see_post: { Args: { p_id: string }; Returns: boolean }
      can_see_postcard: { Args: { pc_id: string }; Returns: boolean }
      can_see_trip: { Args: { t_id: string }; Returns: boolean }
      decrement_discovery_place_saved_count: {
        Args: { p_id: string }
        Returns: number
      }
      in_accepted_circle: {
        Args: { target: string; viewer: string }
        Returns: boolean
      }
      increment_hashtag_usage_count: {
        Args: { p_hashtag_id: string }
        Returns: undefined
      }
      is_accepted_trip_member: { Args: { t_id: string }; Returns: boolean }
      is_blocked: { Args: { a: string; b: string }; Returns: boolean }
      shares_trip_with: { Args: { other: string }; Returns: boolean }
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
      location_sensitivity_level: "low" | "medium" | "high"
      location_source: "gps" | "manual" | "none"
      member_role: "owner" | "member" | "invited" | "co_host" | "viewer"
      post_location_privacy_mode:
        | "none"
        | "hidden"
        | "city_only"
        | "delayed_until_exit"
        | "delayed_until_time"
        | "trusted_circle_only"
      post_status: "active" | "hidden" | "reported" | "deleted"
      post_visibility: "public" | "trip_only" | "private"
      review_entity_type: "trip" | "rent_buddy_booking" | "place"
      review_state: "published" | "hidden" | "removed"
      review_visibility: "public" | "anonymous"
      story_state: "active" | "expired" | "saved" | "deleted" | "removed"
      story_visibility:
        | "public"
        | "friends_only"
        | "close_friends"
        | "trip_crew"
        | "circle_only"
        | "custom"
      tag_permission_level: "anyone" | "interacted" | "friends_only" | "nobody"
      translation_status: "pending" | "translated" | "failed" | "skipped"
      trip_status:
        | "draft"
        | "planning"
        | "upcoming"
        | "active"
        | "completed"
        | "cancelled"
        | "archived"
      trip_visibility: "public" | "buddies" | "private" | "invite"
      verification_method:
        | "gps_current_location"
        | "manual_only"
        | "gps_mismatch"
        | "unavailable"
    }
    CompositeTypes: {
      [_ in never]: never
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
      location_sensitivity_level: ["low", "medium", "high"],
      location_source: ["gps", "manual", "none"],
      member_role: ["owner", "member", "invited", "co_host", "viewer"],
      post_location_privacy_mode: [
        "none",
        "hidden",
        "city_only",
        "delayed_until_exit",
        "delayed_until_time",
        "trusted_circle_only",
      ],
      post_status: ["active", "hidden", "reported", "deleted"],
      post_visibility: ["public", "trip_only", "private"],
      review_entity_type: ["trip", "rent_buddy_booking", "place"],
      review_state: ["published", "hidden", "removed"],
      review_visibility: ["public", "anonymous"],
      story_state: ["active", "expired", "saved", "deleted", "removed"],
      story_visibility: [
        "public",
        "friends_only",
        "close_friends",
        "trip_crew",
        "circle_only",
        "custom",
      ],
      tag_permission_level: ["anyone", "interacted", "friends_only", "nobody"],
      translation_status: ["pending", "translated", "failed", "skipped"],
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
      verification_method: [
        "gps_current_location",
        "manual_only",
        "gps_mismatch",
        "unavailable",
      ],
    },
  },
} as const
