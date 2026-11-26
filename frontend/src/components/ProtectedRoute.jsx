import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { canAccessRoles } from "../auth/demoAuth.js";

export default function ProtectedRoute({ roles }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (!canAccessRoles(user, roles)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
