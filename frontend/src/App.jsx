import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import AppLayout from "./components/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Assignments from "./pages/Assignments.jsx";
import AuditLogs from "./pages/AuditLogs.jsx";
import Bases from "./pages/Bases.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import EquipmentTypes from "./pages/EquipmentTypes.jsx";
import Expenditures from "./pages/Expenditures.jsx";
import Inventory from "./pages/Inventory.jsx";
import Login from "./pages/Login.jsx";
import NotFound from "./pages/NotFound.jsx";
import Personnel from "./pages/Personnel.jsx";
import Purchases from "./pages/Purchases.jsx";
import Reports from "./pages/Reports.jsx";
import Transfers from "./pages/Transfers.jsx";
import Users from "./pages/Users.jsx";

export default function App() {
  const { isDemoSession } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/bases" element={<Bases />} />
          {isDemoSession && <Route path="/personnel" element={<Personnel />} />}
          <Route element={<ProtectedRoute roles={["ADMIN"]} />}>
            <Route path="/users" element={<Users />} />
          </Route>
          <Route path="/equipment-types" element={<EquipmentTypes />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/purchases" element={<Purchases />} />
          <Route path="/transfers" element={<Transfers />} />
          <Route path="/assignments" element={<Assignments />} />
          <Route path="/expenditures" element={<Expenditures />} />
          <Route path="/audit" element={<AuditLogs />} />
          <Route path="/reports" element={<Reports />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
