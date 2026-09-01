import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import LoginPage from './components/layout/LoginPage';
import NurseryBoard from './components/nursery/NurseryBoard';
import NurserySettings from './components/nursery/NurserySettings';
import PhotosManager from './components/nursery/PhotosManager';
import Announcements from './components/announcements/Announcements';
import Absences from './components/absences/Absences';
import Pickup from './components/pickup/Pickup';
import GiftsManager from './components/nursery/GiftsManager';
import ParentChanges from './components/admin/ParentChanges';
import ParentLogin from './components/parent-portal/ParentLogin';
import ParentPortal from './components/parent-portal/ParentPortal';
import ProtectedRoute from './components/layout/ProtectedRoute';
import Dashboard from './components/dashboard/Dashboard';
import { useAuth } from './hooks/useAuth';
import { hasTabAccess } from './config/tabs';
import RegistrationWizard from './components/registration/RegistrationWizard';
import ParentOnboarding from './components/registration/ParentOnboarding';
import RegistrationTracker from './components/registration/RegistrationTracker';
import EmunahEnrollment from './components/registration/EmunahEnrollment';
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
import PayslipAudit from './components/payroll/PayslipAudit';
import PayrollPage from './components/payroll/PayrollPage';
import HolidayManager from './components/holidays/HolidayManager';
import SupplyListManager from './components/holidays/SupplyListManager';
import GanttCalendar from './components/gantt/GanttCalendar';
import SuppliesBoard from './components/supplies/SuppliesBoard';
import ParentVisibilityPanel from './components/gantt/ParentVisibilityPanel';
import GanttEditor from './components/gantt/GanttEditor';
import ClassTrackingPage from './components/classes/ClassTrackingPage';
import MaintenancePage from './components/maintenance/MaintenancePage';
import EventsPage from './components/events/EventsPage';
import EventSignup from './components/events/EventSignup';
import LeadForm from './components/leads/LeadForm';
import LeadsPage from './components/leads/LeadsPage';
import RecruitmentPage from './components/recruitment/RecruitmentPage';
import BranchCertificationsPage from './components/compliance/BranchCertificationsPage';
import ParentLettersPage from './components/parent-letters/ParentLettersPage';
import CoursesPage from './components/compliance/CoursesPage';
import MySalaryPreview from './components/employee-portal/MySalaryPreview';
import MyPayslips from './components/employee-portal/MyPayslips';
import MyDocuments from './components/employee-portal/MyDocuments';
import MyAttendance from './components/employee-portal/MyAttendance';
import Updates from './components/employee-portal/Updates';
import RequestsManager from './components/employees/RequestsManager';
import EmployeeLetters from './components/employees/EmployeeLetters';
import Form101Center from './components/employees/Form101Center';
import PayrollUpdates from './components/payroll/PayrollUpdates';
import BranchPayslips from './components/payroll/BranchPayslips';
import ContractSigning from './components/employees/ContractSigning';
import PayslipFixUpload from './components/public/PayslipFixUpload';
import PermissionsManager from './components/admin/PermissionsManager';
import MyAccount from './components/account/MyAccount';
import StockPage from './components/stock/StockPage';
import PricingManager from './components/pricing/PricingManager';
import { BranchProvider } from './hooks/useBranch';
import { WorkMonthProvider } from './hooks/useWorkMonth';
import { ConfirmProvider } from './components/shared/ConfirmProvider';

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes — rendered STANDALONE, deliberately OUTSIDE the
          management providers (Branch/WorkMonth/Confirm). A parent on /event/:token
          therefore mounts none of the admin shell: no authenticated API calls
          fire, nothing can redirect them to /login or the management app, and a
          refresh just reloads the event page. */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register/:token" element={<ParentOnboarding />} />
      <Route path="/event/:token" element={<EventSignup />} />
      <Route path="/sign-contract/:token" element={<ContractSigning />} />
      {/* The accountant's corrected-payslip upload — token only, no account. */}
      <Route path="/payslip-fix/:token" element={<PayslipFixUpload />} />
      {/* Public new-parent inquiry (marketed link). Standalone, outside the shell. */}
      <Route path="/lead" element={<LeadForm />} />
      <Route path="/lead/:branchId" element={<LeadForm />} />
      {/* Parent portal. Standalone like the rest of this block — it has its own
          accounts, its own token key and its own HTTP client, so mounting the
          management shell around it would fire staff API calls with a token
          that cannot satisfy them and bounce the parent to the staff login. */}
      <Route path="/parents/login" element={<ParentLogin />} />
      <Route path="/parents" element={<ParentPortal />} />

      {/* Protected admin routes — the management providers wrap ONLY this shell. */}
      <Route path="/" element={
        <ConfirmProvider>
          <BranchProvider>
            <WorkMonthProvider>
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            </WorkMonthProvider>
          </BranchProvider>
        </ConfirmProvider>
      }>
        <Route index element={<HomeRoute />} />
        <Route path="registrations" element={<RegistrationTracker />} />
        <Route path="new-registration" element={<RegistrationWizard />} />
        <Route path="edit-registration/:id" element={<RegistrationWizard />} />
        <Route path="external-enrollment" element={
          <ProtectedRoute tab="clicktac">
            <EmunahEnrollment />
          </ProtectedRoute>
        } />
        {/* The two screens used to be two menu entries, and the page used to be
            named after the amuta. Anyone holding an old link — or an old tab
            left open — lands on the merged page instead of a blank one. */}
        <Route path="emunah-enrollment" element={<Navigate to="/external-enrollment" replace />} />
        <Route path="external-enrollments" element={<Navigate to="/external-enrollment" replace />} />
        <Route path="tmt-reconcile" element={<Navigate to="/external-enrollment?view=tmt" replace />} />
        <Route path="collections" element={<CollectionsTable />} />
        <Route path="pricing" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <PricingManager />
          </ProtectedRoute>
        } />
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
        <Route path="payroll" element={
          <ProtectedRoute roles={['system_admin', 'accountant']}>
            <PayrollPage />
          </ProtectedRoute>
        } />
        <Route path="payroll-updates" element={
          <ProtectedRoute roles={['system_admin', 'accountant', 'branch_manager']}>
            <PayrollUpdates />
          </ProtectedRoute>
        } />
        {/* A branch manager's view of the payslips her staff already received.
            Separate from /payroll on purpose: that page is the salary table,
            with every employee's rate and net on it. */}
        <Route path="branch-payslips" element={
          <ProtectedRoute roles={['system_admin', 'accountant', 'branch_manager']}>
            <BranchPayslips />
          </ProtectedRoute>
        } />
        {/* Legacy routes — redirect to unified payroll page */}
        <Route path="salary-table" element={<Navigate to="/payroll?tab=summary" replace />} />
        <Route path="payslip-audit" element={<Navigate to="/payroll?tab=audit" replace />} />
        <Route path="holidays" element={<HolidayManager />} />
        <Route path="parent-supply-list" element={<SupplyListManager />} />
        {/* לוח תינוקייה — infant rooms only; the controller narrows it again
            by branch scope. */}
        <Route path="nursery" element={<NurseryBoard />} />
        <Route path="supplies" element={<SuppliesBoard />} />
        <Route path="gantt/parents" element={<ParentVisibilityPanel />} />
        <Route path="photos" element={<PhotosManager />} />
        <Route
          path="announcements"
          element={<ProtectedRoute tab="announcements"><Announcements /></ProtectedRoute>}
        />
        <Route
          path="absences"
          element={<ProtectedRoute tab="absences"><Absences /></ProtectedRoute>}
        />
        <Route
          path="pickup"
          element={<ProtectedRoute tab="pickup"><Pickup /></ProtectedRoute>}
        />
        <Route path="gifts" element={<GiftsManager />} />
        {/* Editing the lists reshapes the board for every branch, so it stays
            with the people who answer for that. The server enforces the same. */}
        <Route path="nursery/settings" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager']}>
            <NurserySettings />
          </ProtectedRoute>
        } />
        <Route path="parent-changes" element={<ParentChanges />} />
        <Route path="gantt" element={<GanttCalendar />} />
        <Route path="gantt/edit" element={<GanttEditor />} />
        <Route path="classes" element={<ClassTrackingPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="events" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager']}>
            <EventsPage />
          </ProtectedRoute>
        } />
        <Route path="leads" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <LeadsPage />
          </ProtectedRoute>
        } />
        <Route path="recruitment" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <RecruitmentPage />
          </ProtectedRoute>
        } />
        <Route path="parent-letters" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <ParentLettersPage />
          </ProtectedRoute>
        } />
        <Route path="branch-certifications" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <BranchCertificationsPage />
          </ProtectedRoute>
        } />
        <Route path="courses" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <CoursesPage />
          </ProtectedRoute>
        } />
        {/* Employee portal */}
        <Route path="my-salary" element={<MySalaryPreview />} />
        <Route path="my-payslips" element={<MyPayslips />} />
        <Route path="my-documents" element={<MyDocuments />} />
        <Route path="my-attendance" element={<MyAttendance />} />
        <Route path="my-updates" element={<Updates />} />

        <Route path="employee-requests" element={<RequestsManager />} />
        <Route path="employee-letters" element={<EmployeeLetters />} />
        <Route path="form-101" element={
          <ProtectedRoute roles={['system_admin', 'branch_manager', 'accountant']}>
            <Form101Center />
          </ProtectedRoute>
        } />
        <Route path="salary-requests" element={<Navigate to="/payroll?tab=raises" replace />} />
        <Route path="admin/permissions" element={
          <ProtectedRoute roles={['system_admin']}>
            <PermissionsManager />
          </ProtectedRoute>
        } />
        {/* The gan's own commercial screen: what they pay and why. Read-only,
            and system_admin only — this is the relationship with us, not
            something their branch managers need. */}
        <Route path="account" element={
          <ProtectedRoute roles={['system_admin']}>
            <MyAccount />
          </ProtectedRoute>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

/**
 * The landing page depends on the role: management sees the branch dashboard
 * (child counts, KPIs); regular staff have no business there, so they land in
 * their own area instead.
 */
function HomeRoute() {
  const { user } = useAuth();
  if (user && !hasTabAccess(user, 'dashboard')) {
    return <Navigate to="/my-salary" replace />;
  }
  return <Dashboard />;
}

export default function App() {
  return <AppRoutes />;
}
