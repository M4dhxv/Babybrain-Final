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
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'waitlisted';
export type PaymentStatus = 'none' | 'paid' | 'refunded';
export type ProviderRole = 'owner' | 'manager' | 'staff';
export type ProviderStatus = 'draft' | 'pending' | 'active' | 'suspended';
export type SubscriptionPlan = 'free' | 'growth';
export type VendorCategory =
  | 'baby-toddler-classes' | 'playspaces' | 'camps-holiday'
  | 'community-events' | 'mum-bub-exercise' | 'other';
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
          terms_accepted_at: string | null;
          terms_version: string | null;
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
          terms_accepted_at?: string | null;
          terms_version?: string | null;
        };
        Update: {
          full_name?: string;
          phone?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          onboarding_completed_at?: string | null;
          terms_accepted_at?: string | null;
          terms_version?: string | null;
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
          provider_id: string | null;
          location_id: string | null;
          vendor_category: VendorCategory | null;
          requires_medical_disclosure: boolean;
          archived_at: string | null;
          boosted_until: string | null;
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
          provider_id?: string | null;
          location_id?: string | null;
          vendor_category?: VendorCategory | null;
          requires_medical_disclosure?: boolean;
        };
        Update: Partial<Database['public']['Tables']['activities']['Insert']> & {
          archived_at?: string | null;
          boosted_until?: string | null;
        };
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
          location_id: string | null;
          status: 'scheduled' | 'cancelled';
          created_at: string;
        };
        Insert: {
          id?: string;
          activity_id: string;
          starts_at: string;
          ends_at: string;
          capacity?: number | null;
          location_id?: string | null;
          status?: 'scheduled' | 'cancelled';
        };
        Update: {
          starts_at?: string;
          ends_at?: string;
          capacity?: number | null;
          location_id?: string | null;
          status?: 'scheduled' | 'cancelled';
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
          provider_id: string | null;
          status: BookingStatus;
          waitlist_position: number | null;
          medical_disclosure: string | null;
          payment_status: PaymentStatus;
          amount: number | null;
          stripe_payment_intent: string | null;
          reminded_at: string | null;
          followed_up_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          child_id?: string | null;
          session_id: string;
          medical_disclosure?: string | null;
          // provider_id / status / waitlist_position set by trigger
        };
        Update: {
          status?: BookingStatus;
          payment_status?: PaymentStatus;
          amount?: number | null;
          stripe_payment_intent?: string | null;
        };
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
      providers: {
        Row: {
          id: string;
          owner_id: string | null;
          business_name: string;
          slug: string | null;
          description: string;
          vendor_category: VendorCategory | null;
          logo_url: string | null;
          cover_image_url: string | null;
          contact_email: string | null;
          contact_phone: string | null;
          whatsapp: string | null;
          website: string | null;
          social: Json;
          address: string | null;
          postal_code: string | null;
          latitude: number | null;
          longitude: number | null;
          uen: string | null;
          is_claimed: boolean;
          verification_status: 'unverified' | 'pending' | 'verified';
          status: ProviderStatus;
          stripe_account_id: string | null;
          payouts_enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          owner_id?: string | null;
          business_name: string;
          slug?: string | null;
          description?: string;
          vendor_category?: VendorCategory | null;
          logo_url?: string | null;
          cover_image_url?: string | null;
          contact_email?: string | null;
          contact_phone?: string | null;
          whatsapp?: string | null;
          website?: string | null;
          social?: Json;
          address?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          uen?: string | null;
          status?: ProviderStatus;
        };
        Update: Partial<Database['public']['Tables']['providers']['Insert']> & {
          is_claimed?: boolean;
          verification_status?: 'unverified' | 'pending' | 'verified';
          stripe_account_id?: string | null;
          payouts_enabled?: boolean;
        };
        Relationships: [];
      };
      provider_members: {
        Row: {
          id: string;
          provider_id: string;
          user_id: string;
          role: ProviderRole;
          status: 'invited' | 'active' | 'disabled';
          invited_email: string | null;
          created_at: string;
        };
        Insert: {
          provider_id: string;
          user_id: string;
          role: ProviderRole;
          status?: 'invited' | 'active' | 'disabled';
          invited_email?: string | null;
        };
        Update: { role?: ProviderRole; status?: 'invited' | 'active' | 'disabled' };
        Relationships: [];
      };
      provider_locations: {
        Row: {
          id: string;
          provider_id: string;
          name: string;
          address: string | null;
          postal_code: string | null;
          latitude: number | null;
          longitude: number | null;
          operating_hours: Json;
          is_primary: boolean;
          created_at: string;
        };
        Insert: {
          provider_id: string;
          name: string;
          address?: string | null;
          postal_code?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          operating_hours?: Json;
          is_primary?: boolean;
        };
        Update: Partial<Database['public']['Tables']['provider_locations']['Insert']>;
        Relationships: [];
      };
      attendance: {
        Row: {
          id: string;
          booking_id: string;
          session_id: string;
          status: 'present' | 'absent' | 'late';
          note: string | null;
          marked_by: string | null;
          marked_at: string;
        };
        Insert: {
          booking_id: string;
          session_id: string;
          status: 'present' | 'absent' | 'late';
          note?: string | null;
          marked_by?: string | null;
        };
        Update: { status?: 'present' | 'absent' | 'late'; note?: string | null };
        Relationships: [];
      };
      make_up_tokens: {
        Row: {
          id: string;
          provider_id: string;
          user_id: string | null;
          child_id: string | null;
          origin_booking_id: string | null;
          redeemed_booking_id: string | null;
          status: 'issued' | 'redeemed' | 'expired';
          issued_by: string | null;
          created_at: string;
          expires_at: string | null;
        };
        Insert: {
          provider_id: string;
          user_id?: string | null;
          child_id?: string | null;
          origin_booking_id?: string | null;
          status?: 'issued' | 'redeemed' | 'expired';
          issued_by?: string | null;
          expires_at?: string | null;
        };
        Update: {
          status?: 'issued' | 'redeemed' | 'expired';
          redeemed_booking_id?: string | null;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          provider_id: string;
          plan: SubscriptionPlan;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          commission_rate: number;
          updated_at: string;
        };
        Insert: { provider_id: string; plan?: SubscriptionPlan };
        Update: {
          plan?: SubscriptionPlan;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
        };
        Relationships: [];
      };
      customer_subscriptions: {
        Row: {
          user_id: string;
          plan: 'free' | 'plus';
          billing_interval: 'monthly' | 'annual' | null;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          plan?: 'free' | 'plus';
          billing_interval?: 'monthly' | 'annual' | null;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
        };
        Update: {
          plan?: 'free' | 'plus';
          billing_interval?: 'monthly' | 'annual' | null;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      listing_events: {
        Row: {
          id: number;
          provider_id: string | null;
          activity_id: string | null;
          type: 'profile_view' | 'listing_view' | 'booking_click';
          viewer_id: string | null;
          created_at: string;
        };
        Insert: {
          provider_id?: string | null;
          activity_id?: string | null;
          type: 'profile_view' | 'listing_view' | 'booking_click';
          viewer_id?: string | null;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      provider_invites: {
        Row: {
          id: string;
          provider_id: string;
          email: string;
          role: 'manager' | 'staff';
          accepted_at: string | null;
          created_at: string;
        };
        Insert: { provider_id: string; email: string; role: 'manager' | 'staff' };
        Update: { accepted_at?: string | null };
        Relationships: [];
      };
      app_config: {
        Row: { key: string; value: string; updated_at: string };
        Insert: { key: string; value: string };
        Update: { value?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      provider_overview: {
        Args: { p_provider: string };
        Returns: {
          active_listings: number;
          upcoming_bookings: number;
          pending_waitlist: number;
          profile_views_30d: number;
          revenue: number;
        }[];
      };
      provider_analytics: {
        Args: { p_provider: string; p_from?: string | null; p_to?: string | null };
        Returns: Json;
      };
      promote_waitlist_entry: {
        Args: { p_booking_id: string };
        Returns: undefined;
      };
      provider_session_roster: {
        Args: { p_session_id: string };
        Returns: {
          booking_id: string;
          status: BookingStatus;
          payment_status: PaymentStatus;
          child_name: string;
          child_age_months: number | null;
          has_medical: boolean;
          waitlist_position: number | null;
          attendance_status: 'present' | 'absent' | 'late' | null;
        }[];
      };
      respond_to_review: {
        Args: { p_review_id: string; p_response: string };
        Returns: undefined;
      };
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
export type Provider = Database['public']['Tables']['providers']['Row'];
export type ProviderMember = Database['public']['Tables']['provider_members']['Row'];
export type ProviderLocation = Database['public']['Tables']['provider_locations']['Row'];
export type Attendance = Database['public']['Tables']['attendance']['Row'];
export type MakeUpToken = Database['public']['Tables']['make_up_tokens']['Row'];
export type Subscription = Database['public']['Tables']['subscriptions']['Row'];
export type ListingEvent = Database['public']['Tables']['listing_events']['Row'];

/** Returned by the provider_overview RPC (vendor dashboard KPIs). */
export interface ProviderOverview {
  active_listings: number;
  upcoming_bookings: number;
  pending_waitlist: number;
  profile_views_30d: number;
  revenue: number;
}

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
  boosted: boolean;
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
