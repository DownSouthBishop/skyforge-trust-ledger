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
      arsenal_items: {
        Row: {
          confidence_score: number
          content: string
          created_at: string
          id: string
          source: string
          title: string
          type: string
          use_count: number
          user_id: string
          win_count: number
        }
        Insert: {
          confidence_score?: number
          content: string
          created_at?: string
          id?: string
          source?: string
          title: string
          type?: string
          use_count?: number
          user_id: string
          win_count?: number
        }
        Update: {
          confidence_score?: number
          content?: string
          created_at?: string
          id?: string
          source?: string
          title?: string
          type?: string
          use_count?: number
          user_id?: string
          win_count?: number
        }
        Relationships: []
      }
      arsenal_results: {
        Row: {
          arsenal_item_id: string
          converted: boolean
          id: string
          logged_at: string
          receipt_id: string | null
          user_id: string
        }
        Insert: {
          arsenal_item_id: string
          converted?: boolean
          id?: string
          logged_at?: string
          receipt_id?: string | null
          user_id: string
        }
        Update: {
          arsenal_item_id?: string
          converted?: boolean
          id?: string
          logged_at?: string
          receipt_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "arsenal_results_arsenal_item_id_fkey"
            columns: ["arsenal_item_id"]
            isOneToOne: false
            referencedRelation: "arsenal_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arsenal_results_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "receipts_ledger"
            referencedColumns: ["id"]
          },
        ]
      }
      directives_daily: {
        Row: {
          completed: boolean | null
          created_at: string
          directive_text: string | null
          id: string
          user_id: string
        }
        Insert: {
          completed?: boolean | null
          created_at?: string
          directive_text?: string | null
          id?: string
          user_id: string
        }
        Update: {
          completed?: boolean | null
          created_at?: string
          directive_text?: string | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      forge_directives: {
        Row: {
          confidence_score: number
          directive: string
          dismissed: boolean
          generated_at: string
          id: string
          user_id: string
        }
        Insert: {
          confidence_score?: number
          directive: string
          dismissed?: boolean
          generated_at?: string
          id?: string
          user_id: string
        }
        Update: {
          confidence_score?: number
          directive?: string
          dismissed?: boolean
          generated_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      receipts_ledger: {
        Row: {
          action_description: string
          action_id: string
          action_value_usd: number | null
          client_id: string | null
          client_name: string | null
          client_sig: string | null
          created_at: string
          id: string
          location_proof: string | null
          provider_id: string
          provider_sig: string | null
          updated_at: string
          verification_state: Database["public"]["Enums"]["verification_state"]
        }
        Insert: {
          action_description: string
          action_id?: string
          action_value_usd?: number | null
          client_id?: string | null
          client_name?: string | null
          client_sig?: string | null
          created_at?: string
          id?: string
          location_proof?: string | null
          provider_id: string
          provider_sig?: string | null
          updated_at?: string
          verification_state?: Database["public"]["Enums"]["verification_state"]
        }
        Update: {
          action_description?: string
          action_id?: string
          action_value_usd?: number | null
          client_id?: string | null
          client_name?: string | null
          client_sig?: string | null
          created_at?: string
          id?: string
          location_proof?: string | null
          provider_id?: string
          provider_sig?: string | null
          updated_at?: string
          verification_state?: Database["public"]["Enums"]["verification_state"]
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          trusted_connections: number | null
          updated_at: string
          user_bio: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          full_name?: string
          id?: string
          trusted_connections?: number | null
          updated_at?: string
          user_bio?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          trusted_connections?: number | null
          updated_at?: string
          user_bio?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      calculate_trust_score: { Args: { _user_id: string }; Returns: number }
      get_forge_context: { Args: { _user_id: string }; Returns: Json }
    }
    Enums: {
      verification_state: "PENDING" | "VERIFIED" | "DISPUTED"
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
      verification_state: ["PENDING", "VERIFIED", "DISPUTED"],
    },
  },
} as const
