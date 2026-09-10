import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box } from '@mui/material';
import AppShell from './components/layout/AppShell';
import ScreenSkeleton from './components/ui/ScreenSkeleton';
import ScreenBoundary from './components/ui/ScreenBoundary';
import NotFound from './components/layout/NotFound';
import LoginPage from './components/layout/LoginPage';
import ProtectedRoute from './components/layout/ProtectedRoute';
import Dashboard from './components/dashboard/Dashboard';
import { useAuth } from './hooks/useAuth';
import { hasTabAccess } from './config/tabs';
import { BranchProvider } from './hooks/useBranch';
import { WorkMonthProvider } from './hooks/useWorkMonth';
import { AcademicYearProvider } from './hooks/useAcademicYear';
import { ConfirmProvider } from './components/shared/ConfirmProvider';
import { UndoProvider } from './components/shared/UndoProvider';

/**
 * Every screen is its own download.
 *
 * The whole app used to arrive in one 4MB file: opening the dashboard also
 * fetched the payroll table, the Gantt editor, the payslip auditor and the
 * spreadsheet parser, for a person who might open three screens all week.
 * Now a screen's code is fetched the first time somebody goes there, and
 * cached after that.
 *
 * Static above, deliberately: the shell, the login page and the dashboard are
 * on the critical path — FreshEntryGate sends every new tab to `/`, so lazily
 * loading the screen it lands on would buy a spinner and nothing else.
 */
const Absences = lazy(() => import('./components/absences/Absences'));
const Announcements = lazy(() => import('./components/announcements/Announcements'));
const ArchiveList = lazy(() => import('./components/archive/ArchiveList'));
const AttendanceMonitor = lazy(() => import('./components/attendance/AttendanceMonitor'));
const BranchCertificationsPage = lazy(() => import('./components/compliance/BranchCertificationsPage'));
const BranchManager = lazy(() => import('./components/branches/BranchManager'));
const BranchPayslips = lazy(() => import('./components/payroll/BranchPayslips'));
const ClassTrackingPage = lazy(() => import('./components/classes/ClassTrackingPage'));
const CollectionsTable = lazy(() => import('./components/collections/CollectionsTable'));
const ContactListPDF = lazy(() => import('./components/contacts/ContactListPDF'));
const ContractSigning = lazy(() => import('./components/employees/ContractSigning'));
const CoursesPage = lazy(() => import('./components/compliance/CoursesPage'));
const EmployeeLetters = lazy(() => import('./components/employees/EmployeeLetters'));
const EmployeeManager = lazy(() => import('./components/employees/EmployeeManager'));
const EmunahEnrollment = lazy(() => import('./components/registration/EmunahEnrollment'));
const EventSignup = lazy(() => import('./components/events/EventSignup'));
const EventsPage = lazy(() => import('./components/events/EventsPage'));
const Form101Center = lazy(() => import('./components/employees/Form101Center'));
const GanttCalendar = lazy(() => import('./components/gantt/GanttCalendar'));
const GanttEditor = lazy(() => import('./components/gantt/GanttEditor'));
const GiftsManager = lazy(() => import('./components/nursery/GiftsManager'));
const HolidayManager = lazy(() => import('./components/holidays/HolidayManager'));
const LeadForm = lazy(() => import('./components/leads/LeadForm'));
const LeadsPage = lazy(() => import('./components/leads/LeadsPage'));
const MaintenancePage = lazy(() => import('./components/maintenance/MaintenancePage'));
const MyAccount = lazy(() => import('./components/account/MyAccount'));
const MyAttendance = lazy(() => import('./components/employee-portal/MyAttendance'));
const MyDocuments = lazy(() => import('./components/employee-portal/MyDocuments'));
const MyPayslips = lazy(() => import('./components/employee-portal/MyPayslips'));
const MySalaryPreview = lazy(() => import('./components/employee-portal/MySalaryPreview'));
const NurseryBoard = lazy(() => import('./components/nursery/NurseryBoard'));
const NurserySettings = lazy(() => import('./components/nursery/NurserySettings'));
const OrderForm = lazy(() => import('./components/orders/OrderForm'));
const OrderList = lazy(() => import('./components/orders/OrderList'));
const OrderView = lazy(() => import('./components/orders/OrderView'));
const ParentChanges = lazy(() => import('./components/admin/ParentChanges'));
const ParentLettersPage = lazy(() => import('./components/parent-letters/ParentLettersPage'));
const ParentLogin = lazy(() => import('./components/parent-portal/ParentLogin'));
const ParentOnboarding = lazy(() => import('./components/registration/ParentOnboarding'));
const ParentPortal = lazy(() => import('./components/parent-portal/ParentPortal'));
const ParentVisibilityPanel = lazy(() => import('./components/gantt/ParentVisibilityPanel'));
const PayrollPage = lazy(() => import('./components/payroll/PayrollPage'));
const PayrollUpdates = lazy(() => import('./components/payroll/PayrollUpdates'));
const PayslipAudit = lazy(() => import('./components/payroll/PayslipAudit'));
const PayslipFixUpload = lazy(() => import('./components/public/PayslipFixUpload'));
const PermissionsManager = lazy(() => import('./components/admin/PermissionsManager'));
const PhotosManager = lazy(() => import('./components/nursery/PhotosManager'));
const Pickup = lazy(() => import('./components/pickup/Pickup'));
const PricingManager = lazy(() => import('./components/pricing/PricingManager'));
const ProposedChanges = lazy(() => import('./components/admin/ProposedChanges'));
const RecruitmentPage = lazy(() => import('./components/recruitment/RecruitmentPage'));
const RegistrationTracker = lazy(() => import('./components/registration/RegistrationTracker'));
const RegistrationWizard = lazy(() => import('./components/registration/RegistrationWizard'));
const RequestsManager = lazy(() => import('./components/employees/RequestsManager'));
const SalaryRequests = lazy(() => import('./components/employees/SalaryRequests'));
const SalaryTable = lazy(() => import('./components/payroll/SalaryTable'));
const StockPage = lazy(() => import('./components/stock/StockPage'));
const SupplierManager = lazy(() => import('./components/orders/SupplierManager'));
const SuppliesBoard = lazy(() => import('./components/supplies/SuppliesBoard'));
const SupplyListManager = lazy(() => import('./components/holidays/SupplyListManager'));
const Updates = lazy(() => import('./components/employee-portal/Updates'));


function AppRoutes() {
  return (
    // Two boundaries, on purpose. This one catches the public and standalone
    // routes — a parent on /event/:token, the login page — which render with
    // no shell around them. Screens INSIDE the shell have their own boundary
    // in AppShell, around the Outlet, so the rail stays put while one loads
    // instead of the whole window blanking.
    <ScreenBoundary>
    <Suspense fallback={<Box sx={{ p: 3 }}><ScreenSkeleton /></Box>}>
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
          {/* Undo sits beside confirm because it is the other half of the same
              question: confirm is for what cannot be taken back, undo is for
              what can. See components/shared/UndoProvider. */}
          <UndoProvider>
          <BranchProvider>
            {/* Which gan, which year. The two facts every number on every
                screen is implicitly about, and the two that were each being
                re-decided per screen. */}
            <AcademicYearProvider>
              <WorkMonthProvider>
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              </WorkMonthProvider>
            </AcademicYearProvider>
          </BranchProvider>
          </UndoProvider>
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
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
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
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'class_leader', 'cook']}>
            <StockPage />
          </ProtectedRoute>
        } />
        <Route path="suppliers" element={<SupplierManager />} />
        <Route path="employees" element={<EmployeeManager />} />
        <Route path="attendance" element={<AttendanceMonitor />} />
        <Route path="payroll" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'accountant']}>
            <PayrollPage />
          </ProtectedRoute>
        } />
        <Route path="payroll-updates" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'accountant', 'branch_manager']}>
            <PayrollUpdates />
          </ProtectedRoute>
        } />
        {/* A branch manager's view of the payslips her staff already received.
            Separate from /payroll on purpose: that page is the salary table,
            with every employee's rate and net on it. */}
        <Route path="branch-payslips" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'accountant', 'branch_manager']}>
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
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager']}>
            <NurserySettings />
          </ProtectedRoute>
        } />
        <Route path="parent-changes" element={<ParentChanges />} />
        <Route path="gantt" element={<GanttCalendar />} />
        <Route path="gantt/edit" element={<GanttEditor />} />
        <Route path="classes" element={<ClassTrackingPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="events" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager']}>
            <EventsPage />
          </ProtectedRoute>
        } />
        <Route path="leads" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
            <LeadsPage />
          </ProtectedRoute>
        } />
        <Route path="recruitment" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
            <RecruitmentPage />
          </ProtectedRoute>
        } />
        <Route path="parent-letters" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
            <ParentLettersPage />
          </ProtectedRoute>
        } />
        <Route path="branch-certifications" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
            <BranchCertificationsPage />
          </ProtectedRoute>
        } />
        <Route path="courses" element={
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
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
          <ProtectedRoute roles={['system_admin', 'admin_viewer', 'branch_manager', 'accountant']}>
            <Form101Center />
          </ProtectedRoute>
        } />
        <Route path="salary-requests" element={<Navigate to="/payroll?tab=raises" replace />} />
        <Route path="proposed-changes" element={
          <ProtectedRoute tab="proposed_changes">
            <ProposedChanges />
          </ProtectedRoute>
        } />
        <Route path="admin/permissions" element={
          <ProtectedRoute roles={['system_admin']}>
            <PermissionsManager />
          </ProtectedRoute>
        } />
        {/* The gan's own commercial screen: what they pay and why. Read-only,
            and system_admin only — this is the relationship with us, not
            something their branch managers need. */}
        {/* Anything inside the shell that is not a screen. Inside, so the rail
            is there and leaving is one click. */}
        <Route path="*" element={<NotFound />} />

        <Route path="account" element={
          <ProtectedRoute roles={['system_admin']}>
            <MyAccount />
          </ProtectedRoute>
        } />
      </Route>


    </Routes>
    </Suspense>
    </ScreenBoundary>
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
