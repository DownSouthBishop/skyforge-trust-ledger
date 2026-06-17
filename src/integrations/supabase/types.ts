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
      agent_chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          thread_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "agent_chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_chat_threads: {
        Row: {
          agent_slug: string
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_slug: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_slug?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_cross_memory: {
        Row: {
          created_at: string | null
          id: string
          source_agent: string
          summary: string
          topic: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          source_agent: string
          summary: string
          topic?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          source_agent?: string
          summary?: string
          topic?: string | null
          user_id?: string
        }
        Relationships: []
      }
      agent_delegations: {
        Row: {
          created_at: string | null
          from_agent_id: string | null
          id: string
          outcome: string | null
          routing_reason: string | null
          session_id: string | null
          task: string
          to_agent_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          from_agent_id?: string | null
          id?: string
          outcome?: string | null
          routing_reason?: string | null
          session_id?: string | null
          task: string
          to_agent_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          from_agent_id?: string | null
          id?: string
          outcome?: string | null
          routing_reason?: string | null
          session_id?: string | null
          task?: string
          to_agent_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_delegations_from_agent_id_fkey"
            columns: ["from_agent_id"]
            isOneToOne: false
            referencedRelation: "skyforge_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_delegations_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "agent_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_delegations_to_agent_id_fkey"
            columns: ["to_agent_id"]
            isOneToOne: false
            referencedRelation: "skyforge_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory: {
        Row: {
          agent_id: string
          confidence: number | null
          created_at: string | null
          evidence_count: number | null
          id: string
          key: string
          last_reinforced: string | null
          memory_type: string
          source_session: string | null
          updated_at: string | null
          user_id: string
          value: string
        }
        Insert: {
          agent_id: string
          confidence?: number | null
          created_at?: string | null
          evidence_count?: number | null
          id?: string
          key: string
          last_reinforced?: string | null
          memory_type: string
          source_session?: string | null
          updated_at?: string | null
          user_id: string
          value: string
        }
        Update: {
          agent_id?: string
          confidence?: number | null
          created_at?: string | null
          evidence_count?: number | null
          id?: string
          key?: string
          last_reinforced?: string | null
          memory_type?: string
          source_session?: string | null
          updated_at?: string | null
          user_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "skyforge_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_source_session_fkey"
            columns: ["source_session"]
            isOneToOne: false
            referencedRelation: "agent_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_reflections: {
        Row: {
          agent_id: string
          autonomy_delta: string | null
          blind_spots: string | null
          capability_gaps: string | null
          created_at: string | null
          id: string
          patterns: string | null
          quality_score: number | null
          raw_output: string | null
          reflection_model: string | null
          session_ids: string[] | null
          updated_priors: Json | null
          user_id: string
          what_failed: string | null
          what_worked: string | null
        }
        Insert: {
          agent_id: string
          autonomy_delta?: string | null
          blind_spots?: string | null
          capability_gaps?: string | null
          created_at?: string | null
          id?: string
          patterns?: string | null
          quality_score?: number | null
          raw_output?: string | null
          reflection_model?: string | null
          session_ids?: string[] | null
          updated_priors?: Json | null
          user_id: string
          what_failed?: string | null
          what_worked?: string | null
        }
        Update: {
          agent_id?: string
          autonomy_delta?: string | null
          blind_spots?: string | null
          capability_gaps?: string | null
          created_at?: string | null
          id?: string
          patterns?: string | null
          quality_score?: number | null
          raw_output?: string | null
          reflection_model?: string | null
          session_ids?: string[] | null
          updated_priors?: Json | null
          user_id?: string
          what_failed?: string | null
          what_worked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_reflections_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "skyforge_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_sessions: {
        Row: {
          actions_taken: Json | null
          agent_id: string
          autonomy_score: number | null
          completed_at: string | null
          duration_ms: number | null
          id: string
          messages: Json | null
          outcome: string | null
          outcome_notes: string | null
          reflected: boolean | null
          reflected_at: string | null
          started_at: string | null
          task_description: string
          tokens_used: number | null
          user_id: string
        }
        Insert: {
          actions_taken?: Json | null
          agent_id: string
          autonomy_score?: number | null
          completed_at?: string | null
          duration_ms?: number | null
          id?: string
          messages?: Json | null
          outcome?: string | null
          outcome_notes?: string | null
          reflected?: boolean | null
          reflected_at?: string | null
          started_at?: string | null
          task_description: string
          tokens_used?: number | null
          user_id: string
        }
        Update: {
          actions_taken?: Json | null
          agent_id?: string
          autonomy_score?: number | null
          completed_at?: string | null
          duration_ms?: number | null
          id?: string
          messages?: Json | null
          outcome?: string | null
          outcome_notes?: string | null
          reflected?: boolean | null
          reflected_at?: string | null
          started_at?: string | null
          task_description?: string
          tokens_used?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_sessions_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "skyforge_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_shared_knowledge: {
        Row: {
          created_at: string
          fact: string
          id: string
          importance: number | null
          source_agent: string
          topic: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fact: string
          id?: string
          importance?: number | null
          source_agent: string
          topic?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fact?: string
          id?: string
          importance?: number | null
          source_agent?: string
          topic?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
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
      atlas_approvals: {
        Row: {
          agent: string
          category: string
          created_at: string
          decided_at: string | null
          decided_note: string | null
          expires_at: string | null
          id: string
          payload: Json
          status: string
          summary: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent?: string
          category: string
          created_at?: string
          decided_at?: string | null
          decided_note?: string | null
          expires_at?: string | null
          id?: string
          payload?: Json
          status?: string
          summary: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent?: string
          category?: string
          created_at?: string
          decided_at?: string | null
          decided_note?: string | null
          expires_at?: string | null
          id?: string
          payload?: Json
          status?: string
          summary?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      atlas_browser_commands: {
        Row: {
          approval_id: string | null
          args: Json
          command: string
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          receipt_id: string | null
          result: Json | null
          risk: string
          started_at: string | null
          status: string
          updated_at: string
          user_id: string
          worker_id: string | null
        }
        Insert: {
          approval_id?: string | null
          args?: Json
          command: string
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          receipt_id?: string | null
          result?: Json | null
          risk?: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id: string
          worker_id?: string | null
        }
        Update: {
          approval_id?: string | null
          args?: Json
          command?: string
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          receipt_id?: string | null
          result?: Json | null
          risk?: string
          started_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "atlas_browser_commands_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "atlas_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atlas_browser_commands_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "atlas_receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      atlas_capabilities: {
        Row: {
          config: Json
          created_at: string
          description: string | null
          id: string
          installed_at: string | null
          last_used: string | null
          name: string
          permissions: Json
          source_url: string | null
          status: string
          trust_score: number
          type: string
          updated_at: string
          user_id: string
          vault_ref: string | null
          version: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          installed_at?: string | null
          last_used?: string | null
          name: string
          permissions?: Json
          source_url?: string | null
          status?: string
          trust_score?: number
          type: string
          updated_at?: string
          user_id: string
          vault_ref?: string | null
          version?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          description?: string | null
          id?: string
          installed_at?: string | null
          last_used?: string | null
          name?: string
          permissions?: Json
          source_url?: string | null
          status?: string
          trust_score?: number
          type?: string
          updated_at?: string
          user_id?: string
          vault_ref?: string | null
          version?: string | null
        }
        Relationships: []
      }
      atlas_mcp_connections: {
        Row: {
          args: string[] | null
          capabilities: Json
          category: string | null
          command: string | null
          created_at: string
          env_vars: Json
          icon_url: string | null
          id: string
          is_active: boolean
          is_verified: boolean
          last_ping_at: string | null
          name: string
          notes: string | null
          slug: string
          transport: string
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          args?: string[] | null
          capabilities?: Json
          category?: string | null
          command?: string | null
          created_at?: string
          env_vars?: Json
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          last_ping_at?: string | null
          name: string
          notes?: string | null
          slug: string
          transport: string
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          args?: string[] | null
          capabilities?: Json
          category?: string | null
          command?: string | null
          created_at?: string
          env_vars?: Json
          icon_url?: string | null
          id?: string
          is_active?: boolean
          is_verified?: boolean
          last_ping_at?: string | null
          name?: string
          notes?: string | null
          slug?: string
          transport?: string
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      atlas_preferences: {
        Row: {
          claude_code_config: Json
          cowork_config: Json
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          claude_code_config?: Json
          cowork_config?: Json
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          claude_code_config?: Json
          cowork_config?: Json
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      atlas_receipts: {
        Row: {
          action: string
          agent: string
          created_at: string
          financial_impact: number | null
          id: string
          metadata: Json
          objective: string | null
          outcome: string | null
          reason: string | null
          result: string | null
          user_id: string
        }
        Insert: {
          action: string
          agent?: string
          created_at?: string
          financial_impact?: number | null
          id?: string
          metadata?: Json
          objective?: string | null
          outcome?: string | null
          reason?: string | null
          result?: string | null
          user_id: string
        }
        Update: {
          action?: string
          agent?: string
          created_at?: string
          financial_impact?: number | null
          id?: string
          metadata?: Json
          objective?: string | null
          outcome?: string | null
          reason?: string | null
          result?: string | null
          user_id?: string
        }
        Relationships: []
      }
      atlas_tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          payload: Json
          result: Json | null
          scheduled_for: string
          started_at: string | null
          status: string
          task_type: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          payload?: Json
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          task_type: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          payload?: Json
          result?: Json | null
          scheduled_for?: string
          started_at?: string | null
          status?: string
          task_type?: string
          user_id?: string
        }
        Relationships: []
      }
      atlas_vault: {
        Row: {
          capability_id: string | null
          created_at: string
          id: string
          kind: string
          label: string
          last_used: string | null
          notes: string | null
          scope: string | null
          secret_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capability_id?: string | null
          created_at?: string
          id?: string
          kind: string
          label: string
          last_used?: string | null
          notes?: string | null
          scope?: string | null
          secret_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capability_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          label?: string
          last_used?: string | null
          notes?: string | null
          scope?: string | null
          secret_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "atlas_vault_capability_id_fkey"
            columns: ["capability_id"]
            isOneToOne: false
            referencedRelation: "atlas_capabilities"
            referencedColumns: ["id"]
          },
        ]
      }
      business_projects: {
        Row: {
          created_at: string | null
          description: string | null
          goal_deadline: string | null
          goal_revenue_usd: number | null
          id: string
          mission: string | null
          name: string
          status: string | null
          user_id: string
          website: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          goal_deadline?: string | null
          goal_revenue_usd?: number | null
          id?: string
          mission?: string | null
          name: string
          status?: string | null
          user_id: string
          website?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          goal_deadline?: string | null
          goal_revenue_usd?: number | null
          id?: string
          mission?: string | null
          name?: string
          status?: string | null
          user_id?: string
          website?: string | null
        }
        Relationships: []
      }
      chat_threads: {
        Row: {
          agent_slug: string
          created_at: string
          id: string
          messages: Json
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_slug?: string
          created_at?: string
          id?: string
          messages?: Json
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_slug?: string
          created_at?: string
          id?: string
          messages?: Json
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      cowork_activity_log: {
        Row: {
          action_type: string
          created_at: string
          detail: string | null
          id: string
          target_path: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          detail?: string | null
          id?: string
          target_path?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          detail?: string | null
          id?: string
          target_path?: string | null
          user_id?: string
        }
        Relationships: []
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
      forge_alerts: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          message: string
          read_at: string | null
          signal_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          message: string
          read_at?: string | null
          signal_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          message?: string
          read_at?: string | null
          signal_type?: string
          user_id?: string
        }
        Relationships: []
      }
      forge_commitments: {
        Row: {
          created_at: string
          description: string
          follow_up_count: number
          id: string
          last_followed_up_at: string | null
          made_at: string
          resolution_at: string | null
          resolution_status: string
          target_date: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          description: string
          follow_up_count?: number
          id?: string
          last_followed_up_at?: string | null
          made_at?: string
          resolution_at?: string | null
          resolution_status?: string
          target_date?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          follow_up_count?: number
          id?: string
          last_followed_up_at?: string | null
          made_at?: string
          resolution_at?: string | null
          resolution_status?: string
          target_date?: string | null
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
      forge_dossier: {
        Row: {
          active_ideas: Json | null
          avoidance_pattern: string | null
          businesses: Json | null
          conversation_count_at_last_update: number
          created_at: string
          current_emotional_signal: string | null
          current_focus: string | null
          current_phase: string | null
          decision_pattern: string | null
          emotional_baseline: string | null
          follow_through_pattern: string | null
          id: string
          last_heavy_exchange: string | null
          last_heavy_exchange_at: string | null
          market: string | null
          max_drawdown_pct: string | null
          money_beliefs: string | null
          preferred_asset_classes: string | null
          preferred_pairs: string | null
          risk_posture: string | null
          risk_tolerance: string | null
          team_size: string | null
          trade: string | null
          trading_goals: string | null
          updated_at: string
          user_id: string
          years_in_business: number | null
        }
        Insert: {
          active_ideas?: Json | null
          avoidance_pattern?: string | null
          businesses?: Json | null
          conversation_count_at_last_update?: number
          created_at?: string
          current_emotional_signal?: string | null
          current_focus?: string | null
          current_phase?: string | null
          decision_pattern?: string | null
          emotional_baseline?: string | null
          follow_through_pattern?: string | null
          id?: string
          last_heavy_exchange?: string | null
          last_heavy_exchange_at?: string | null
          market?: string | null
          max_drawdown_pct?: string | null
          money_beliefs?: string | null
          preferred_asset_classes?: string | null
          preferred_pairs?: string | null
          risk_posture?: string | null
          risk_tolerance?: string | null
          team_size?: string | null
          trade?: string | null
          trading_goals?: string | null
          updated_at?: string
          user_id: string
          years_in_business?: number | null
        }
        Update: {
          active_ideas?: Json | null
          avoidance_pattern?: string | null
          businesses?: Json | null
          conversation_count_at_last_update?: number
          created_at?: string
          current_emotional_signal?: string | null
          current_focus?: string | null
          current_phase?: string | null
          decision_pattern?: string | null
          emotional_baseline?: string | null
          follow_through_pattern?: string | null
          id?: string
          last_heavy_exchange?: string | null
          last_heavy_exchange_at?: string | null
          market?: string | null
          max_drawdown_pct?: string | null
          money_beliefs?: string | null
          preferred_asset_classes?: string | null
          preferred_pairs?: string | null
          risk_posture?: string | null
          risk_tolerance?: string | null
          team_size?: string | null
          trade?: string | null
          trading_goals?: string | null
          updated_at?: string
          user_id?: string
          years_in_business?: number | null
        }
        Relationships: []
      }
      forge_lessons: {
        Row: {
          completed: boolean
          completed_at: string | null
          content: string
          created_at: string
          id: string
          key_concepts: string[]
          lesson_number: number
          subject_id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          completed?: boolean
          completed_at?: string | null
          content?: string
          created_at?: string
          id?: string
          key_concepts?: string[]
          lesson_number: number
          subject_id: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          completed?: boolean
          completed_at?: string | null
          content?: string
          created_at?: string
          id?: string
          key_concepts?: string[]
          lesson_number?: number
          subject_id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forge_lessons_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "forge_subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      forge_messages: {
        Row: {
          arsenal_item_id: string | null
          attachments: Json | null
          content: string
          created_at: string
          id: string
          resolved: boolean
          role: string
          ui: string | null
          user_id: string
        }
        Insert: {
          arsenal_item_id?: string | null
          attachments?: Json | null
          content?: string
          created_at?: string
          id?: string
          resolved?: boolean
          role: string
          ui?: string | null
          user_id: string
        }
        Update: {
          arsenal_item_id?: string | null
          attachments?: Json | null
          content?: string
          created_at?: string
          id?: string
          resolved?: boolean
          role?: string
          ui?: string | null
          user_id?: string
        }
        Relationships: []
      }
      forge_quiz_responses: {
        Row: {
          correct_answer: string | null
          created_at: string
          id: string
          is_correct: boolean | null
          janus_explanation: string | null
          question_index: number
          question_text: string
          quiz_id: string
          user_answer: string | null
          user_id: string
        }
        Insert: {
          correct_answer?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          janus_explanation?: string | null
          question_index: number
          question_text: string
          quiz_id: string
          user_answer?: string | null
          user_id: string
        }
        Update: {
          correct_answer?: string | null
          created_at?: string
          id?: string
          is_correct?: boolean | null
          janus_explanation?: string | null
          question_index?: number
          question_text?: string
          quiz_id?: string
          user_answer?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forge_quiz_responses_quiz_id_fkey"
            columns: ["quiz_id"]
            isOneToOne: false
            referencedRelation: "forge_quizzes"
            referencedColumns: ["id"]
          },
        ]
      }
      forge_quizzes: {
        Row: {
          completed: boolean
          completed_at: string | null
          created_at: string
          id: string
          lesson_id: string | null
          passed: boolean | null
          questions: Json
          quiz_type: string
          score: number | null
          subject_id: string
          user_id: string
        }
        Insert: {
          completed?: boolean
          completed_at?: string | null
          created_at?: string
          id?: string
          lesson_id?: string | null
          passed?: boolean | null
          questions?: Json
          quiz_type?: string
          score?: number | null
          subject_id: string
          user_id: string
        }
        Update: {
          completed?: boolean
          completed_at?: string | null
          created_at?: string
          id?: string
          lesson_id?: string | null
          passed?: boolean | null
          questions?: Json
          quiz_type?: string
          score?: number | null
          subject_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forge_quizzes_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "forge_lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forge_quizzes_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "forge_subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      forge_sticky_memory: {
        Row: {
          commitment: string | null
          created_at: string
          goal: string | null
          id: string
          obstacle: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          commitment?: string | null
          created_at?: string
          goal?: string | null
          id?: string
          obstacle?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          commitment?: string | null
          created_at?: string
          goal?: string | null
          id?: string
          obstacle?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      forge_subject_chats: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          subject_id: string
          user_id: string
        }
        Insert: {
          content?: string
          created_at?: string
          id?: string
          role: string
          subject_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          subject_id?: string
          user_id?: string
        }
        Relationships: []
      }
      forge_subjects: {
        Row: {
          category: string | null
          created_at: string
          current_lesson: number
          description: string | null
          id: string
          lesson_count: number
          mastery_score: number
          name: string
          status: string
          teacher: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          current_lesson?: number
          description?: string | null
          id?: string
          lesson_count?: number
          mastery_score?: number
          name: string
          status?: string
          teacher?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          current_lesson?: number
          description?: string | null
          id?: string
          lesson_count?: number
          mastery_score?: number
          name?: string
          status?: string
          teacher?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      goals: {
        Row: {
          context: string | null
          created_at: string | null
          id: string
          importance: string | null
          status: string | null
          title: string
          user_id: string
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          id?: string
          importance?: string | null
          status?: string | null
          title: string
          user_id: string
        }
        Update: {
          context?: string | null
          created_at?: string | null
          id?: string
          importance?: string | null
          status?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      income_goals: {
        Row: {
          business_vertical: string | null
          created_at: string
          id: string
          is_active: boolean
          label: string | null
          period: string
          target_amount: number
          updated_at: string
          user_id: string
        }
        Insert: {
          business_vertical?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          period: string
          target_amount: number
          updated_at?: string
          user_id: string
        }
        Update: {
          business_vertical?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string | null
          period?: string
          target_amount?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      income_pipeline: {
        Row: {
          business_vertical: string | null
          client_name: string | null
          created_at: string
          description: string
          estimated_value: number | null
          id: string
          notes: string | null
          stage: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_vertical?: string | null
          client_name?: string | null
          created_at?: string
          description: string
          estimated_value?: number | null
          id?: string
          notes?: string | null
          stage?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_vertical?: string | null
          client_name?: string | null
          created_at?: string
          description?: string
          estimated_value?: number | null
          id?: string
          notes?: string | null
          stage?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          context: string | null
          created_at: string | null
          date: string
          id: string
          importance: string | null
          title: string
          user_id: string
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          date: string
          id?: string
          importance?: string | null
          title: string
          user_id: string
        }
        Update: {
          context?: string | null
          created_at?: string | null
          date?: string
          id?: string
          importance?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      market_watchlist: {
        Row: {
          alert_price_high: number | null
          alert_price_low: number | null
          asset_class: string
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          notes: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          alert_price_high?: number | null
          alert_price_low?: number | null
          asset_class: string
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          alert_price_high?: number | null
          alert_price_low?: number | null
          asset_class?: string
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: []
      }
      mcp_directory: {
        Row: {
          args: string[] | null
          author: string | null
          category: string | null
          command: string | null
          created_at: string
          description: string | null
          docs_url: string | null
          icon: string | null
          id: string
          install_count: number | null
          is_featured: boolean | null
          name: string
          required_env_vars: Json | null
          slug: string
          transport: string | null
          url: string | null
        }
        Insert: {
          args?: string[] | null
          author?: string | null
          category?: string | null
          command?: string | null
          created_at?: string
          description?: string | null
          docs_url?: string | null
          icon?: string | null
          id?: string
          install_count?: number | null
          is_featured?: boolean | null
          name: string
          required_env_vars?: Json | null
          slug: string
          transport?: string | null
          url?: string | null
        }
        Update: {
          args?: string[] | null
          author?: string | null
          category?: string | null
          command?: string | null
          created_at?: string
          description?: string | null
          docs_url?: string | null
          icon?: string | null
          id?: string
          install_count?: number | null
          is_featured?: boolean | null
          name?: string
          required_env_vars?: Json | null
          slug?: string
          transport?: string | null
          url?: string | null
        }
        Relationships: []
      }
      objectives: {
        Row: {
          context: string | null
          created_at: string | null
          goal_id: string
          id: string
          letter: string
          status: string | null
          title: string
          user_id: string
        }
        Insert: {
          context?: string | null
          created_at?: string | null
          goal_id: string
          id?: string
          letter: string
          status?: string | null
          title: string
          user_id: string
        }
        Update: {
          context?: string | null
          created_at?: string | null
          goal_id?: string
          id?: string
          letter?: string
          status?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "objectives_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id"]
          },
        ]
      }
      project_bottlenecks: {
        Row: {
          created_at: string | null
          description: string
          id: string
          project_id: string | null
          resolved: boolean | null
          severity: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description: string
          id?: string
          project_id?: string | null
          resolved?: boolean | null
          severity?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string
          id?: string
          project_id?: string | null
          resolved?: boolean | null
          severity?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_bottlenecks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_clients: {
        Row: {
          company: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string | null
          notes: string | null
          project_id: string | null
          revenue_usd: number | null
          status: string | null
          user_id: string
        }
        Insert: {
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          project_id?: string | null
          revenue_usd?: number | null
          status?: string | null
          user_id: string
        }
        Update: {
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          project_id?: string | null
          revenue_usd?: number | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_clients_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_financials: {
        Row: {
          amount_usd: number
          created_at: string | null
          date: string | null
          description: string | null
          entry_type: string
          id: string
          project_id: string | null
          user_id: string
        }
        Insert: {
          amount_usd: number
          created_at?: string | null
          date?: string | null
          description?: string | null
          entry_type: string
          id?: string
          project_id?: string | null
          user_id: string
        }
        Update: {
          amount_usd?: number
          created_at?: string | null
          date?: string | null
          description?: string | null
          entry_type?: string
          id?: string
          project_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_financials_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_leads: {
        Row: {
          company: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string | null
          notes: string | null
          project_id: string | null
          source: string | null
          temperature: string | null
          user_id: string
        }
        Insert: {
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          project_id?: string | null
          source?: string | null
          temperature?: string | null
          user_id: string
        }
        Update: {
          company?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          notes?: string | null
          project_id?: string | null
          source?: string | null
          temperature?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_leads_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_memory: {
        Row: {
          agent: string
          content: string
          created_at: string | null
          id: string
          memory_type: string | null
          project_id: string | null
          user_id: string
        }
        Insert: {
          agent: string
          content: string
          created_at?: string | null
          id?: string
          memory_type?: string | null
          project_id?: string | null
          user_id: string
        }
        Update: {
          agent?: string
          content?: string
          created_at?: string | null
          id?: string
          memory_type?: string | null
          project_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_memory_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_onboarding: {
        Row: {
          created_at: string | null
          customer_description: string | null
          id: string
          problem_solved: string | null
          project_id: string | null
          revenue_model: string | null
          user_id: string
          what_was_tried: string | null
          win_in_90_days: string | null
        }
        Insert: {
          created_at?: string | null
          customer_description?: string | null
          id?: string
          problem_solved?: string | null
          project_id?: string | null
          revenue_model?: string | null
          user_id: string
          what_was_tried?: string | null
          win_in_90_days?: string | null
        }
        Update: {
          created_at?: string | null
          customer_description?: string | null
          id?: string
          problem_solved?: string | null
          project_id?: string | null
          revenue_model?: string | null
          user_id?: string
          what_was_tried?: string | null
          win_in_90_days?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_onboarding_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "business_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      receipts_ledger: {
        Row: {
          action_description: string
          action_id: string
          action_value_usd: number | null
          business_vertical: string | null
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
          business_vertical?: string | null
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
          business_vertical?: string | null
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
      research_notes: {
        Row: {
          content: string
          created_at: string
          id: string
          note_type: string
          obsidian_path: string | null
          symbol: string | null
          synced_to_obsidian: boolean
          title: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          note_type: string
          obsidian_path?: string | null
          symbol?: string | null
          synced_to_obsidian?: boolean
          title: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          note_type?: string
          obsidian_path?: string | null
          symbol?: string | null
          synced_to_obsidian?: boolean
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      shared_operator_memory: {
        Row: {
          confidence: number
          context: string | null
          created_at: string
          expires_at: string | null
          id: string
          key: string
          memory_type: string
          source_agent: string
          updated_at: string
          user_id: string
          value: string
        }
        Insert: {
          confidence?: number
          context?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          key: string
          memory_type: string
          source_agent: string
          updated_at?: string
          user_id: string
          value: string
        }
        Update: {
          confidence?: number
          context?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          key?: string
          memory_type?: string
          source_agent?: string
          updated_at?: string
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      skyforge_agents: {
        Row: {
          approval_threshold_usd: number | null
          auto_execute: boolean | null
          avatar_emoji: string | null
          bio: string[] | null
          capabilities: Json | null
          clients: string[] | null
          created_at: string | null
          id: string
          is_active: boolean | null
          model: string | null
          name: string
          plugins: string[] | null
          reflect_after_sessions: number | null
          role: string
          slug: string
          style_notes: string[] | null
          system_prompt: string
          topics: string[] | null
          updated_at: string | null
          user_id: string
          version: number | null
        }
        Insert: {
          approval_threshold_usd?: number | null
          auto_execute?: boolean | null
          avatar_emoji?: string | null
          bio?: string[] | null
          capabilities?: Json | null
          clients?: string[] | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          model?: string | null
          name: string
          plugins?: string[] | null
          reflect_after_sessions?: number | null
          role: string
          slug: string
          style_notes?: string[] | null
          system_prompt: string
          topics?: string[] | null
          updated_at?: string | null
          user_id: string
          version?: number | null
        }
        Update: {
          approval_threshold_usd?: number | null
          auto_execute?: boolean | null
          avatar_emoji?: string | null
          bio?: string[] | null
          capabilities?: Json | null
          clients?: string[] | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          model?: string | null
          name?: string
          plugins?: string[] | null
          reflect_after_sessions?: number | null
          role?: string
          slug?: string
          style_notes?: string[] | null
          system_prompt?: string
          topics?: string[] | null
          updated_at?: string | null
          user_id?: string
          version?: number | null
        }
        Relationships: []
      }
      skyforge_clients: {
        Row: {
          client_email: string | null
          client_name: string
          client_phone: string | null
          created_at: string
          followup_status: string
          id: string
          job_count: number
          last_job_date: string | null
          last_job_type: string | null
          next_followup_date: string | null
          notes: string | null
          total_spend: number
          user_id: string
        }
        Insert: {
          client_email?: string | null
          client_name: string
          client_phone?: string | null
          created_at?: string
          followup_status?: string
          id?: string
          job_count?: number
          last_job_date?: string | null
          last_job_type?: string | null
          next_followup_date?: string | null
          notes?: string | null
          total_spend?: number
          user_id: string
        }
        Update: {
          client_email?: string | null
          client_name?: string
          client_phone?: string | null
          created_at?: string
          followup_status?: string
          id?: string
          job_count?: number
          last_job_date?: string | null
          last_job_type?: string | null
          next_followup_date?: string | null
          notes?: string | null
          total_spend?: number
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          code: string
          context: string | null
          created_at: string | null
          due_date: string | null
          id: string
          importance: string | null
          objective_id: string
          status: string | null
          title: string
          user_id: string
        }
        Insert: {
          code: string
          context?: string | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          importance?: string | null
          objective_id: string
          status?: string | null
          title: string
          user_id: string
        }
        Update: {
          code?: string
          context?: string | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          importance?: string | null
          objective_id?: string
          status?: string | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_objective_id_fkey"
            columns: ["objective_id"]
            isOneToOne: false
            referencedRelation: "objectives"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_sessions: {
        Row: {
          active_agent: string
          chat_id: string
          created_at: string
          last_message_at: string
          user_id: string | null
        }
        Insert: {
          active_agent?: string
          chat_id: string
          created_at?: string
          last_message_at?: string
          user_id?: string | null
        }
        Update: {
          active_agent?: string
          chat_id?: string
          created_at?: string
          last_message_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      trade_ledger: {
        Row: {
          asset_class: string
          broker: string
          broker_order_id: string | null
          closed_at: string | null
          created_at: string
          direction: string
          entry_price: number
          exit_price: number | null
          id: string
          opened_at: string
          pnl_pct: number | null
          pnl_usd: number | null
          quantity: number
          status: string
          symbol: string
          tags: string[] | null
          thesis: string | null
          user_id: string
        }
        Insert: {
          asset_class: string
          broker: string
          broker_order_id?: string | null
          closed_at?: string | null
          created_at?: string
          direction: string
          entry_price: number
          exit_price?: number | null
          id?: string
          opened_at?: string
          pnl_pct?: number | null
          pnl_usd?: number | null
          quantity: number
          status?: string
          symbol: string
          tags?: string[] | null
          thesis?: string | null
          user_id: string
        }
        Update: {
          asset_class?: string
          broker?: string
          broker_order_id?: string | null
          closed_at?: string | null
          created_at?: string
          direction?: string
          entry_price?: number
          exit_price?: number | null
          id?: string
          opened_at?: string
          pnl_pct?: number | null
          pnl_usd?: number | null
          quantity?: number
          status?: string
          symbol?: string
          tags?: string[] | null
          thesis?: string | null
          user_id?: string
        }
        Relationships: []
      }
      trading_accounts: {
        Row: {
          account_id: string
          account_type: string
          balance_usd: number | null
          broker: string
          buying_power_usd: number | null
          created_at: string
          currency: string
          id: string
          is_active: boolean
          last_sync_at: string | null
          user_id: string
        }
        Insert: {
          account_id: string
          account_type: string
          balance_usd?: number | null
          broker: string
          buying_power_usd?: number | null
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          user_id: string
        }
        Update: {
          account_id?: string
          account_type?: string
          balance_usd?: number | null
          broker?: string
          buying_power_usd?: number | null
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          atlas_reengagement_message: string | null
          atlas_relationship_stage: number
          atlas_weekly_review: string | null
          atlas_weekly_review_at: string | null
          created_at: string
          full_name: string
          id: string
          last_seen_at: string | null
          trajectory_sentence: string | null
          trusted_connections: number | null
          updated_at: string
          user_bio: string | null
          user_id: string
        }
        Insert: {
          atlas_reengagement_message?: string | null
          atlas_relationship_stage?: number
          atlas_weekly_review?: string | null
          atlas_weekly_review_at?: string | null
          created_at?: string
          full_name?: string
          id?: string
          last_seen_at?: string | null
          trajectory_sentence?: string | null
          trusted_connections?: number | null
          updated_at?: string
          user_bio?: string | null
          user_id: string
        }
        Update: {
          atlas_reengagement_message?: string | null
          atlas_relationship_stage?: number
          atlas_weekly_review?: string | null
          atlas_weekly_review_at?: string | null
          created_at?: string
          full_name?: string
          id?: string
          last_seen_at?: string | null
          trajectory_sentence?: string | null
          trusted_connections?: number | null
          updated_at?: string
          user_bio?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      agent_unified_history: {
        Row: {
          agent_slug: string | null
          content: string | null
          created_at: string | null
          medium: string | null
          role: string | null
          user_id: string | null
        }
        Relationships: []
      }
      atlas_mcp_connections_safe: {
        Row: {
          args: string[] | null
          capabilities: Json | null
          command: string | null
          created_at: string | null
          env_var_keys: string[] | null
          id: string | null
          is_active: boolean | null
          is_verified: boolean | null
          last_ping_at: string | null
          name: string | null
          notes: string | null
          slug: string | null
          transport: string | null
          updated_at: string | null
          url: string | null
          user_id: string | null
        }
        Insert: {
          args?: string[] | null
          capabilities?: Json | null
          command?: string | null
          created_at?: string | null
          env_var_keys?: never
          id?: string | null
          is_active?: boolean | null
          is_verified?: boolean | null
          last_ping_at?: string | null
          name?: string | null
          notes?: string | null
          slug?: string | null
          transport?: string | null
          updated_at?: string | null
          url?: string | null
          user_id?: string | null
        }
        Update: {
          args?: string[] | null
          capabilities?: Json | null
          command?: string | null
          created_at?: string | null
          env_var_keys?: never
          id?: string | null
          is_active?: boolean | null
          is_verified?: boolean | null
          last_ping_at?: string | null
          name?: string | null
          notes?: string | null
          slug?: string | null
          transport?: string | null
          updated_at?: string | null
          url?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      calculate_trust_score: { Args: { _user_id: string }; Returns: number }
      correct_dossier_field: {
        Args: { _field_name: string; _new_value: string }
        Returns: undefined
      }
      export_operator_data: { Args: never; Returns: Json }
      get_crm_opportunities: {
        Args: { _user_id: string }
        Returns: {
          client_email: string | null
          client_name: string
          client_phone: string | null
          created_at: string
          followup_status: string
          id: string
          job_count: number
          last_job_date: string | null
          last_job_type: string | null
          next_followup_date: string | null
          notes: string | null
          total_spend: number
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "skyforge_clients"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_forge_context: { Args: { _user_id: string }; Returns: Json }
      seed_default_agents: { Args: { p_user_id: string }; Returns: undefined }
      upsert_shared_memory: {
        Args: {
          _confidence?: number
          _context?: string
          _expires_at?: string
          _key: string
          _memory_type: string
          _source_agent: string
          _user_id: string
          _value: string
        }
        Returns: undefined
      }
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
