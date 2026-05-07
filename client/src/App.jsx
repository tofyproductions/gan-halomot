import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import LoginPage from './components/layout/LoginPage';
import ProtectedRoute from './components/layout/ProtectedRoute';
import Dashboard from './components/dashboard/Dashboard';
import RegistrationWizard from './components/registration/RegistrationWizard';
import ParentOnboarding from './components/registration/ParentOnboarding';
import RegistrationTracker from './components/registration/RegistrationTracker';
import CollectionsTable from './components/collections/CollectionsTable';
import ArchiveList from './components/archive/ArchiveList';
import ContactListPDF from './components/contacts/ContactListPDF';
import BranchManager from './components/branches/BranchManager';
import OrderList from './components/orders/OrderList';
import OrderForm from './components/orders/OrderForm';
import OrderView from './components/orders/OrderView';
import SupplierManager from './components/orders/SupplierManager';
import EmployeeManager from './components/employees/EmployeeManager';
import SalaryRequests from './components/employees/SalaryRequests';
import AttendanceMonitor from './components/attendance/AttendanceMonitor';
import SalaryTable from './components/payroll/SalaryTable';
import HolidayManager from './components/holidays/HolidayManager';
import GanttCalendar from './components/gantt/GanttCalendar';
import GanttEditor from './components/gantt/GanttEditor';
import MySalaryPreview from './components/employee-portal/MySalaryPreview';
import MyPayslips from './components/employee-portal/MyPayslips';
import MyDocuments from './components/employee-portal/MyDocuments';
import MyAttendance from './components/employee-portal/MyAttendance';
import Updates from './components/employee-portal/Updates';
import RequestsManager from './components/employees/RequestsManager';
import PermissionsManager from './components/admin/PermissionsManager';
import StockPage from './components/stock/StockPage';
import { BranchProvider } from './hooks/useBranch';

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register/:token" element={<ParentOnboarding />} />

      {/* Protected admin routes */}
      <Route path="/" element={
        <ProtectedRoute>
          <Layout />
        </ProtectedRoute>
      }>
        <Route index element={<Dashboard />} />
        <Route path="registrations" element={<RegistrationTracker />} />
        <Route path="new-registration" element={<RegistrationWizard />} />
        <Route path="edit-registration/:id" element={<RegistrationWizard />} />
        <Route path="collections" element={<CollectionsTable />} />
        <Route path="archive" element={<ArchiveList />} />
        <Route path="contacts" element={<ContactListPDF />} />
        <Route path="branches" element={<BranchManager />} />
        <Route path="orders" element={<OrderList />} />
        <Route path="orders/new" element={<OrderForm />} />
        <Route path="orders/:id/edit" element={<OrderForm />} />
        <Route path="orders/:id" element={<OrderView />} />
        <Route path="stock" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'class_leader', 'cook']}>
            <StockPage />
          </ProtectedRoute>
        } />
        <Route path="suppliers" element={<SupplierManager />} />
        <Route path="employees" element={<EmployeeManager />} />
        <Route path="attendance" element={<AttendanceMonitor />} />
        <Route path="salary-table" element={<SalaryTable />} />
        <Route path="holidays" element={<HolidayManager />} />
        <Route path="gantt" element={<GanttCalendar />} />
        <Route path="gantt/edit" element={<GanttEditor />} />
        {/* Employee portal */}
        <Route path="my-salary" element={<MySalaryPreview />} />
        <Route path="my-payslips" element={<MyPayslips />} />
        <Route path="my-documents" element={<MyDocuments />} />
        <Route path="my-attendance" element={<MyAttendance />} />
        <Route path="my-updates" element={<Updates />} />

        <Route path="employee-requests" element={<RequestsManager />} />
        <Route path="salary-requests" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager']}>
            <SalaryRequests />
          </ProtectedRoute>
        } />
        <Route path="admin/permissions" element={
          <ProtectedRoute roles={['system_admin']}>
            <PermissionsManager />
          </ProtectedRoute>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BranchProvider>
      <AppRoutes />
    </BranchProvider>
  );
}
