/**
 * An icon for every screen in the rail.
 *
 * Kept out of config/tabs.js on purpose: that file is imported by a plain node
 * test and by server-side tooling, and it stays free of MUI imports so it can
 * be. This is the other half — the part that only a React tree needs.
 *
 * COMPLETE, and it has to stay that way. The map this replaces (ICON_BY_TAB in
 * the old Header.jsx) covered 28 of 43 screens, which was survivable in a
 * dropdown where most entries were text anyway. In a rail of forty rows a
 * missing icon is not a neutral gap, it reads as a broken row — so `iconFor`
 * never returns undefined, and anything unmapped gets a neutral mark instead.
 */
import DashboardIcon from '@mui/icons-material/Dashboard';
import ForumIcon from '@mui/icons-material/Forum';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import RuleFolderIcon from '@mui/icons-material/RuleFolder';
import DescriptionIcon from '@mui/icons-material/Description';
import ChecklistIcon from '@mui/icons-material/Checklist';
import PriceChangeIcon from '@mui/icons-material/PriceChange';
import ArchiveIcon from '@mui/icons-material/Archive';
import VerifiedIcon from '@mui/icons-material/Verified';
import PeopleIcon from '@mui/icons-material/People';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import FingerprintIcon from '@mui/icons-material/Fingerprint';
import PaymentsIcon from '@mui/icons-material/Payments';
import EditNoteIcon from '@mui/icons-material/EditNote';
import ReceiptIcon from '@mui/icons-material/Receipt';
import BeachAccessIcon from '@mui/icons-material/BeachAccess';
import AssignmentIcon from '@mui/icons-material/Assignment';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import ArticleIcon from '@mui/icons-material/Article';
import SchoolIcon from '@mui/icons-material/School';
import ChildCareIcon from '@mui/icons-material/ChildCare';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import NotificationsIcon from '@mui/icons-material/Notifications';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import LocalActivityIcon from '@mui/icons-material/LocalActivity';
import CelebrationIcon from '@mui/icons-material/Celebration';
import CampaignIcon from '@mui/icons-material/Campaign';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import DirectionsWalkIcon from '@mui/icons-material/DirectionsWalk';
import ContactsIcon from '@mui/icons-material/Contacts';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import WarehouseIcon from '@mui/icons-material/Warehouse';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import HandymanIcon from '@mui/icons-material/Handyman';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import FolderIcon from '@mui/icons-material/Folder';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import StorefrontIcon from '@mui/icons-material/Storefront';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import CircleOutlinedIcon from '@mui/icons-material/CircleOutlined';

export const ICON_BY_TAB = {
  // ניהול
  dashboard: DashboardIcon,
  leads: ForumIcon,
  registrations: PersonAddIcon,
  // רישום חיצוני is the תמ"ת ↔ קליקטאק comparison, so: two arrows.
  clicktac: CompareArrowsIcon,
  collections: ReceiptLongIcon,
  proposed_changes: RuleFolderIcon,
  parent_letters: DescriptionIcon,
  parent_supply_list: ChecklistIcon,
  pricing: PriceChangeIcon,
  archive: ArchiveIcon,
  branch_certifications: VerifiedIcon,
  branches: StorefrontIcon,
  permissions: AdminPanelSettingsIcon,

  // כוח אדם
  employees: PeopleIcon,
  recruitment: PersonSearchIcon,
  attendance: FingerprintIcon,
  payroll: PaymentsIcon,
  payroll_updates: EditNoteIcon,
  branch_payslips: ReceiptIcon,
  holidays: BeachAccessIcon,
  employee_requests: AssignmentIcon,
  employee_letters: MailOutlineIcon,
  form_101: ArticleIcon,
  courses: SchoolIcon,

  // תפעול
  nursery: ChildCareIcon,
  supplies: Inventory2Icon,
  parent_changes: NotificationsIcon,
  photos: PhotoLibraryIcon,
  gifts: CardGiftcardIcon,
  gantt: CalendarMonthIcon,
  classes: LocalActivityIcon,
  events: CelebrationIcon,
  announcements: CampaignIcon,
  absences: EventBusyIcon,
  pickup: DirectionsWalkIcon,
  contacts: ContactsIcon,

  // אחזקה ולוגיסטיקה
  orders: ShoppingCartIcon,
  stock: WarehouseIcon,
  suppliers: LocalShippingIcon,
  maintenance: HandymanIcon,

  // האזור האישי של העובד
  my_salary: AccountBalanceWalletIcon,
  my_payslips: DescriptionIcon,
  my_documents: FolderIcon,
  my_attendance: AccessTimeIcon,
  my_updates: NotificationsActiveIcon,
};

/** Never returns undefined: an unmapped id gets a neutral mark, not a gap. */
export function iconFor(tabId) {
  return ICON_BY_TAB[tabId] || CircleOutlinedIcon;
}
