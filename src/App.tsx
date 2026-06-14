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
import WigPage from "@/pages/WigPage";
import MentalForgePage from "@/pages/MentalForgePage";
import ProjectsPage from "@/pages/ProjectsPage";
import ProjectWarRoomPage from "@/pages/ProjectWarRoomPage";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-primary font-display animate-pulse-glow tracking-widest">ATLAS</div>
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  return <AppLayout>{children}</AppLayout>;
};


const PublicRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
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
            <Route path="/wig" element={<ProtectedRoute><WigPage /></ProtectedRoute>} />
            <Route path="/mental-forge" element={<ProtectedRoute><MentalForgePage /></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
