import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import AppLayout from "@/components/AppLayout";
import LoginPage from "@/pages/LoginPage";
import HudPage from "@/pages/HudPage";
import PositionsPage from "@/pages/PositionsPage";
import ProfilePage from "@/pages/ProfilePage";
import IntelPage from "@/pages/IntelPage";
import ArsenalPage from "@/pages/ArsenalPage";
import MarketsPage from "@/pages/MarketsPage";
import AtlasDashboard from "@/pages/AtlasDashboard";
import AtlasPage from "@/pages/AtlasPage";
import DossierPage from "@/pages/DossierPage";
import VaultPage from "@/pages/VaultPage";
import VerifyPage from "@/pages/VerifyPage";
import BusinessPage from "@/pages/BusinessPage";
import RealEstatePage from "@/pages/RealEstatePage";
import AgentsPage from "@/pages/AgentsPage";
import AgentChatPage from "@/pages/AgentChatPage";

import LindaLeadsPage from "@/pages/LindaLeadsPage";
import LindaCampaignsPage from "@/pages/LindaCampaignsPage";
import LindaClientsPage from "@/pages/LindaClientsPage";
import LindaInboxPage from "@/pages/LindaInboxPage";
import LindaIcpPage from "@/pages/LindaIcpPage";
import LindaDashboardPage from "@/pages/LindaDashboardPage";
import WigPage from "@/pages/WigPage";
import MentalForgePage from "@/pages/MentalForgePage";
import ProjectsPage from "@/pages/ProjectsPage";
import ProjectWarRoomPage from "@/pages/ProjectWarRoomPage";
import FinancialHQPage from "@/pages/FinancialHQPage";
import SpendTrackerPage from "@/pages/SpendTrackerPage";
import ClosedChamberPage from "@/pages/ClosedChamberPage";
import MetricsPage from "@/pages/MetricsPage";
import VeilPage from "@/pages/VeilPage";
import NotebookPage from "@/pages/NotebookPage";
import SkillsPage from "@/pages/SkillsPage";
import NotFound from "@/pages/NotFound";
import GoogleCallbackPage from "@/pages/GoogleCallbackPage";
import AirtablePage from "@/pages/AirtablePage";
import AirtableCallbackPage from "@/pages/AirtableCallbackPage";

const queryClient = new QueryClient();

// No login wall — the app opens straight into the operator's workspace.
// We still wait for the backend session to settle so RLS-backed queries work.
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { loading } = useAuth();
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-primary font-display animate-pulse-glow tracking-widest">ATLAS</div>
    </div>
  );
  return <AppLayout>{children}</AppLayout>;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/" element={<ProtectedRoute><HudPage /></ProtectedRoute>} />
            <Route path="/forge" element={<Navigate to="/atlas" replace />} />
            <Route path="/atlas" element={<ProtectedRoute><AtlasPage /></ProtectedRoute>} />
            <Route path="/discourse" element={<Navigate to="/command" replace />} />
            {/* Atlas command dashboard — weekly review interface */}
            <Route path="/command" element={<ProtectedRoute><AtlasDashboard /></ProtectedRoute>} />
            <Route path="/positions" element={<ProtectedRoute><PositionsPage /></ProtectedRoute>} />
            <Route path="/dashboard" element={<Navigate to="/command" replace />} />
            <Route path="/markets" element={<ProtectedRoute><MarketsPage /></ProtectedRoute>} />
            <Route path="/clients" element={<Navigate to="/markets" replace />} />
            <Route path="/arsenal" element={<ProtectedRoute><ArsenalPage /></ProtectedRoute>} />
            <Route path="/intel" element={<ProtectedRoute><IntelPage /></ProtectedRoute>} />
            <Route path="/dossier" element={<ProtectedRoute><DossierPage /></ProtectedRoute>} />
            <Route path="/vault" element={<ProtectedRoute><VaultPage /></ProtectedRoute>} />
            <Route path="/business" element={<ProtectedRoute><BusinessPage /></ProtectedRoute>} />
            <Route path="/realestate" element={<ProtectedRoute><RealEstatePage /></ProtectedRoute>} />
            <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
            <Route path="/agent-chat" element={<ProtectedRoute><AgentChatPage /></ProtectedRoute>} />
            <Route path="/agent-chat/:slug" element={<ProtectedRoute><AgentChatPage /></ProtectedRoute>} />
            <Route path="/command-center" element={<Navigate to="/agents" replace />} />
            <Route path="/linda" element={<Navigate to="/linda/leads" replace />} />
            <Route path="/linda/leads" element={<ProtectedRoute><LindaLeadsPage /></ProtectedRoute>} />
            <Route path="/linda/campaigns" element={<ProtectedRoute><LindaCampaignsPage /></ProtectedRoute>} />
            <Route path="/linda/clients" element={<ProtectedRoute><LindaClientsPage /></ProtectedRoute>} />
            <Route path="/linda/inbox" element={<ProtectedRoute><LindaInboxPage /></ProtectedRoute>} />
            <Route path="/linda/icp" element={<ProtectedRoute><LindaIcpPage /></ProtectedRoute>} />
            <Route path="/linda/dashboard" element={<ProtectedRoute><LindaDashboardPage /></ProtectedRoute>} />
            <Route path="/wig" element={<ProtectedRoute><WigPage /></ProtectedRoute>} />
            <Route path="/mental-forge" element={<ProtectedRoute><MentalForgePage /></ProtectedRoute>} />
            <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
            <Route path="/projects/:id" element={<ProtectedRoute><ProjectWarRoomPage /></ProtectedRoute>} />
            <Route path="/financial-hq" element={<ProtectedRoute><FinancialHQPage /></ProtectedRoute>} />
            <Route path="/spend-tracker" element={<ProtectedRoute><SpendTrackerPage /></ProtectedRoute>} />
            <Route path="/closed-chamber" element={<ProtectedRoute><ClosedChamberPage /></ProtectedRoute>} />
            <Route path="/metrics" element={<ProtectedRoute><MetricsPage /></ProtectedRoute>} />
            <Route path="/veil" element={<ProtectedRoute><VeilPage /></ProtectedRoute>} />
            <Route path="/notebook" element={<ProtectedRoute><NotebookPage /></ProtectedRoute>} />
            <Route path="/skills" element={<ProtectedRoute><SkillsPage /></ProtectedRoute>} />
            <Route path="/airtable" element={<ProtectedRoute><AirtablePage /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
            <Route path="/auth/google/callback" element={<GoogleCallbackPage />} />
            <Route path="/auth/airtable/callback" element={<AirtableCallbackPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
