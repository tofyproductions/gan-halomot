import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/layout/Layout';
import Dashboard from './components/dashboard/Dashboard';
import RegistrationWizard from './components/registration/RegistrationWizard';
import ParentOnboarding from './components/registration/ParentOnboarding';
import CollectionsTable from './components/collections/CollectionsTable';
import ArchiveList from './components/archive/ArchiveList';
import ContactListPDF from './components/contacts/ContactListPDF';

function AppRoutes() {
  return (
    <Routes>
      {/* Public parent-facing routes */}
      <Route path="/register/:token" element={<ParentOnboarding />} />

      {/* Admin routes (open access, like original GAS app) */}
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="new-registration" element={<RegistrationWizard />} />
        <Route path="edit-registration/:id" element={<RegistrationWizard />} />
        <Route path="collections" element={<CollectionsTable />} />
        <Route path="archive" element={<ArchiveList />} />
        <Route path="contacts" element={<ContactListPDF />} />
      </Route>

      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  return <AppRoutes />;
}
