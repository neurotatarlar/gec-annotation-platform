import { Navigate, Outlet, Route, Routes } from "react-router-dom";

import { AppLayout } from "./components/AppLayout";
import { useAuth } from "./context/AuthContext";
import { SaveStatusProvider } from "./context/SaveStatusContext";
import { AnnotationPage } from "./pages/AnnotationPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { DashboardPage } from "./pages/DashboardPage";

const PrivateLayout = () => {
  const { token } = useAuth();
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return (
    <SaveStatusProvider>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </SaveStatusProvider>
  );
};

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<PrivateLayout />}>
        <Route path="/" element={<CategoriesPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/annotate/:textId" element={<AnnotationPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
