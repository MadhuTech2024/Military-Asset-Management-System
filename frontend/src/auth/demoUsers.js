export const DEMO_USERS = Object.freeze([
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Synthetic Demo Administrator",
    email: "admin.demo@example.com",
    role: "ADMIN",
    baseId: null,
    isActive: true,
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000002",
    name: "Synthetic Demo Base Commander",
    email: "commander.demo@example.com",
    role: "BASE_COMMANDER",
    baseId: "00000000-0000-4000-8000-000000000010",
    isActive: true,
  }),
  Object.freeze({
    id: "00000000-0000-4000-8000-000000000003",
    name: "Synthetic Demo Logistics Officer",
    email: "logistics.demo@example.com",
    role: "LOGISTICS_OFFICER",
    baseId: "00000000-0000-4000-8000-000000000010",
    isActive: true,
  }),
]);
