/**
 * BabyBrain Phase 1 — database types.
 *
 * Hand-maintained to exactly match supabase/migrations (the hosted
 * schema). Written in the same shape `supabase gen types typescript`
 * produces so it can be swapped for generated output later:
 *   npx supabase gen types typescript --db-url "$SUPABASE_DB_URL" > types/database.ts
 * (requires Docker or a Supabase access token; keep the domain
 * aliases at the bottom of this file when regenerating.)
 *
 * Write-access is enforced by RLS, not by these types — e.g. clients
 * can only UPDATE notifications.read_at (column-level grant), and
 * activities/sessions/recommendations are service-role/SQL-only.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type PreferredDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type PreferredTime = 'morning' | 'afternoon' | 'evening';
export type Gender = 'male' | 'female' | 'other' | 'unspecified';
export type BookingStatus = 'confirmed' | 'attended' | 'cancelled';
export type EmailStatus = 'pending' | 'sent' | 'skipped' | 'failed';
export type SortOption = 'popular' | 'rating' | 'distance';

export type Database = {
  public: {
    Tables: {
      parent_profiles: {
        Row: {
          id: string;
          full_name: string;
          email: string;
          phone: string | null;
          postal_code: string | null;
          latitude: number | null;
          longitude: number | null;
          onboarding_completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string;
          phone?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          onboarding_completed_at?: string | null;
        };
        Update: {
          full_name?: string;
          phone?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          onboarding_completed_at?: string | null;
        };
              Relationships: [];
      };
      user_preferences: {
        Row: {
          user_id: string;
          preferred_days: PreferredDay[];
          preferred_times: PreferredTime[];
          budget_min: number | null;
          budget_max: number | null;
          interests: string[];
          updated_at: string;
        };
        Insert: {
          user_id: string;
          preferred_days?: PreferredDay[];
          preferred_times?: PreferredTime[];
          budget_min?: number | null;
          budget_max?: number | null;
          interests?: string[];
        };
        Update: {
          preferred_days?: PreferredDay[];
          preferred_times?: PreferredTime[];
          budget_min?: number | null;
          budget_max?: number | null;
          interests?: string[];
        };
              Relationships: [
          {
            foreignKeyName: 'user_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      children: {
        Row: {
          id: string;
          parent_id: string;
          name: string;
          date_of_birth: string;
          gender: Gender;
          interests: string[];
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          parent_id: string;
          name: string;
          date_of_birth: string;
          gender?: Gender;
          interests?: string[];
          notes?: string | null;
        };
        Update: {
          name?: string;
          date_of_birth?: string;
          gender?: Gender;
          interests?: string[];
          notes?: string | null;
        };
              Relationships: [
          {
            foreignKeyName: 'children_parent_id_fkey';
            columns: ['parent_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      activity_categories: {
        Row: { id: number; slug: string; name: string; sort_order: number };
        Insert: { slug: string; name: string; sort_order?: number };
        Update: { slug?: string; name?: string; sort_order?: number };
              Relationships: [];
      };
      activities: {
        Row: {
          id: string;
          slug: string;
          title: string;
          description: string;
          category_id: number;
          tags: string[];
          provider_name: string;
          age_min_months: number;
          age_max_months: number;
          price: number | null;
          address: string | null;
          postal_code: string | null;
          latitude: number | null;
          longitude: number | null;
          image_urls: string[];
          is_published: boolean;
          rating_avg: number;
          rating_count: number;
          popularity: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          title: string;
          description?: string;
          category_id: number;
          tags?: string[];
          provider_name?: string;
          age_min_months?: number;
          age_max_months?: number;
          price?: number | null;
          address?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          image_urls?: string[];
          is_published?: boolean;
        };
        Update: Partial<Database['public']['Tables']['activities']['Insert']>;
              Relationships: [
          {
            foreignKeyName: 'activities_category_id_fkey';
            columns: ['category_id'];
            isOneToOne: false;
            referencedRelation: 'activity_categories';
            referencedColumns: ['id'];
          },
        ];
      };
      activity_sessions: {
        Row: {
          id: string;
          activity_id: string;
          starts_at: string;
          ends_at: string;
          capacity: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          activity_id: string;
          starts_at: string;
          ends_at: string;
          capacity?: number | null;
        };
        Update: {
          starts_at?: string;
          ends_at?: string;
          capacity?: number | null;
        };
              Relationships: [
          {
            foreignKeyName: 'activity_sessions_activity_id_fkey';
            columns: ['activity_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id'];
          },
        ];
      };
      favorites: {
        Row: { user_id: string; activity_id: string; created_at: string };
        Insert: { user_id: string; activity_id: string };
        Update: Record<string, never>;
              Relationships: [
          {
            foreignKeyName: 'favorites_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'favorites_activity_id_fkey';
            columns: ['activity_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id'];
          },
        ];
      };
      reviews: {
        Row: {
          id: string;
          user_id: string;
          activity_id: string;
          rating: number;
          comment: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          activity_id: string;
          rating: number;
          comment?: string | null;
        };
        Update: { rating?: number; comment?: string | null };
              Relationships: [
          {
            foreignKeyName: 'reviews_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reviews_activity_id_fkey';
            columns: ['activity_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id'];
          },
        ];
      };
      user_recommendations: {
        Row: {
          id: string;
          user_id: string;
          child_id: string;
          activity_id: string;
          score: number;
          reasons: string[];
          computed_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          child_id: string;
          activity_id: string;
          score: number;
          reasons?: string[];
        };
        Update: Record<string, never>;
              Relationships: [
          {
            foreignKeyName: 'user_recommendations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_recommendations_child_id_fkey';
            columns: ['child_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_recommendations_activity_id_fkey';
            columns: ['activity_id'];
            isOneToOne: false;
            referencedRelation: 'activities';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          type: string;
          title: string;
          body: string;
          data: Json;
          read_at: string | null;
          email_status: EmailStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: string;
          title: string;
          body?: string;
          data?: Json;
        };
        Update: { read_at?: string | null; email_status?: EmailStatus };
              Relationships: [
          {
            foreignKeyName: 'notifications_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      stream_users: {
        Row: {
          user_id: string;
          stream_user_id: string;
          support_channel_id: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          stream_user_id: string;
          support_channel_id?: string | null;
        };
        Update: { support_channel_id?: string | null };
              Relationships: [
          {
            foreignKeyName: 'stream_users_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      bookings: {
        Row: {
          id: string;
          user_id: string;
          child_id: string | null;
          session_id: string;
          status: BookingStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          child_id?: string | null;
          session_id: string;
          status?: BookingStatus;
        };
        Update: { status?: BookingStatus };
              Relationships: [
          {
            foreignKeyName: 'bookings_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'parent_profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'bookings_child_id_fkey';
            columns: ['child_id'];
            isOneToOne: false;
            referencedRelation: 'children';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'bookings_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'activity_sessions';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      child_age_months: {
        Args: { dob: string };
        Returns: number;
      };
      child_journey_stats: {
        Args: { p_child_id: string };
        Returns: {
          classes_attended: number;
          venues_explored: number;
          hours_of_learning: number;
        }[];
      };
      compute_recommendations_for_child: {
        Args: { p_child_id: string };
        Returns: undefined;
      };
      compute_recommendations_for_parent: {
        Args: { p_parent_id: string };
        Returns: undefined;
      };
      distance_km: {
        Args: { lat1: number; lng1: number; lat2: number; lng2: number };
        Returns: number;
      };
      search_activities: {
        Args: {
          p_query?: string | null;
          p_category_slug?: string | null;
          p_age_months?: number | null;
          p_date?: string | null;
          p_lat?: number | null;
          p_lng?: number | null;
          p_radius_km?: number | null;
          p_sort?: SortOption;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: ActivitySearchResult[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}

// ---------- Domain aliases used across the app ----------

export type ParentProfile = Database['public']['Tables']['parent_profiles']['Row'];
export type UserPreferences = Database['public']['Tables']['user_preferences']['Row'];
export type Child = Database['public']['Tables']['children']['Row'];
export type ActivityCategory = Database['public']['Tables']['activity_categories']['Row'];
export type Activity = Database['public']['Tables']['activities']['Row'];
export type ActivitySession = Database['public']['Tables']['activity_sessions']['Row'];
export type Favorite = Database['public']['Tables']['favorites']['Row'];
export type Review = Database['public']['Tables']['reviews']['Row'];
export type UserRecommendation = Database['public']['Tables']['user_recommendations']['Row'];
export type AppNotification = Database['public']['Tables']['notifications']['Row'];
export type StreamUser = Database['public']['Tables']['stream_users']['Row'];
export type Booking = Database['public']['Tables']['bookings']['Row'];

/** Card-shaped row returned by the search_activities RPC (explore page). */
export interface ActivitySearchResult {
  id: string;
  slug: string;
  title: string;
  category_slug: string;
  category_name: string;
  age_min_months: number;
  age_max_months: number;
  price: number | null;
  image_urls: string[];
  latitude: number | null;
  longitude: number | null;
  rating_avg: number;
  rating_count: number;
  popularity: number;
  next_session_at: string | null;
  dist_km: number | null;
}

/** Returned by the child_journey_stats RPC (dashboard "Journey" card). */
export interface JourneyStats {
  classes_attended: number;
  venues_explored: number;
  hours_of_learning: number;
}

/** Recommendation joined with its activity for dashboard/matches pages. */
export type RecommendationWithActivity = UserRecommendation & {
  activities: Activity | null;
};

/** Format an age range in months for display, e.g. "6 months – 3 years". */
export function formatAgeRange(minMonths: number, maxMonths: number): string {
  const fmt = (m: number) =>
    m < 24 ? `${m} months` : `${Math.round((m / 12) * 10) / 10} years`;
  return `${fmt(minMonths)} – ${fmt(maxMonths)}`;
}

/** Age like "2y 3m" from an ISO date of birth. */
export function formatChildAge(dateOfBirth: string): string {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let months =
    (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth());
  if (now.getDate() < dob.getDate()) months -= 1;
  months = Math.max(0, months);
  return `${Math.floor(months / 12)}y ${months % 12}m`;
}
