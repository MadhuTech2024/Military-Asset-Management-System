import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "../components/ui.jsx";

const CHART_COLORS = ["#166534", "#0f766e", "#0369a1", "#a16207", "#7c3aed", "#be123c"];

function ChartPanel({ title, description, children }) {
  return (
    <Panel title={title} description={description}>
      <div className="h-72 min-w-0">{children}</div>
    </Panel>
  );
}

export default function DemoDashboardCharts({ dashboard }) {
  const categories = dashboard.categoryTotals.reduce((groups, item) => {
    const group = groups.find((entry) => entry.name === item.category);
    if (group) group.available += item.available;
    else groups.push({ name: item.category, available: item.available });
    return groups;
  }, []);

  return (
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <ChartPanel title="Available inventory by base" description="Current ledger balance after completed movements">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dashboard.baseTotals} margin={{ top: 8, right: 12, left: 0, bottom: 24 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="code" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Bar dataKey="available" name="Available" fill="#166534" radius={[5, 5, 0, 0]} />
            <Bar dataKey="assigned" name="Net assigned" fill="#0f766e" radius={[5, 5, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title="Inventory by equipment category" description="Available synthetic units by catalog category">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={categories}
              dataKey="available"
              nameKey="name"
              innerRadius={55}
              outerRadius={92}
              paddingAngle={2}
            >
              {categories.map((item, index) => (
                <Cell key={item.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title="Purchases and expenditures" description="Six-month quantity trend; pending purchases are excluded">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={dashboard.monthlyActivity} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="purchases" name="Completed purchases" stroke="#166534" strokeWidth={3} />
            <Line type="monotone" dataKey="expenditures" name="Expenditures" stroke="#b45309" strokeWidth={3} />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title="Completed transfers between bases" description="Inventory moves only when a transfer is completed">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dashboard.transferFlows} layout="vertical" margin={{ top: 8, right: 18, left: 18, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 12 }} />
            <YAxis type="category" dataKey="route" width={90} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="quantity" name="Units moved" fill="#0369a1" radius={[0, 5, 5, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  );
}
