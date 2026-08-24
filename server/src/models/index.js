const User = require('./User');
const PayrollRollup = require('./PayrollRollup');
const Branch = require('./Branch');
const Classroom = require('./Classroom');
const Registration = require('./Registration');
const Child = require('./Child');
const Collection = require('./Collection');
const Archive = require('./Archive');
const Document = require('./Document');
const CollectionHistory = require('./CollectionHistory');
const PriceAdjustment = require('./PriceAdjustment');
const SalaryRequest = require('./SalaryRequest');
const Holiday = require('./Holiday');
const Activity = require('./Activity');
const Discount = require('./Discount');
const GanttMonth = require('./GanttMonth');
const Supplier = require('./Supplier');
const Product = require('./Product');
const Order = require('./Order');
// Attendance / payroll (TIMEDOX replacement)
const Amuta = require('./Amuta');
const Announcement = require('./Announcement');
const Absence = require('./Absence');
const PickupAuthorization = require('./PickupAuthorization');
const SmsBudget = require('./SmsBudget');
const Employee = require('./Employee');
const Punch = require('./Punch');
const AgentCommand = require('./AgentCommand');
const Contract = require('./Contract');
const ContractVersion = require('./ContractVersion');
const EmployeeRequest = require('./EmployeeRequest');
const StockCategory = require('./StockCategory');
const StockItem = require('./StockItem');
const StockMovement = require('./StockMovement');
const StockBatch = require('./StockBatch');
const PayslipAuditRecord = require('./PayslipAuditRecord');
const PayslipAuditPdf = require('./PayslipAuditPdf');
const SavedPayslip = require('./SavedPayslip');
const DirectPayslipBatch = require('./DirectPayslipBatch');
const HoursDistributionLog = require('./HoursDistributionLog');
const PayrollMonth = require('./PayrollMonth');
const PayrollPresetOption = require('./PayrollPresetOption');
const PayrollCustomColumn = require('./PayrollCustomColumn');
const SalaryAdjustment = require('./SalaryAdjustment');
const EmployeeCommitment = require('./EmployeeCommitment');
const PayrollChangeRequest = require('./PayrollChangeRequest');
const BranchPricing = require('./BranchPricing');
const SummerCamp = require('./SummerCamp');
const EmployeeLetter = require('./EmployeeLetter');
const EmploymentContract = require('./EmploymentContract');
const ContractAnnex = require('./ContractAnnex');
const SpecialDay = require('./SpecialDay');
const CibusSync = require('./CibusSync');
const EmployeeDocument = require('./EmployeeDocument');
const Form101Sync = require('./Form101Sync');
const Form101Inbox = require('./Form101Inbox');
const Setting = require('./Setting');
const ClassProvider = require('./ClassProvider');
const ClassProgram = require('./ClassProgram');
const ClassSession = require('./ClassSession');
const MaintenanceItem = require('./MaintenanceItem');
const EmployeeChangeRequest = require('./EmployeeChangeRequest');
const GanEvent = require('./GanEvent');
const Lead = require('./Lead');
const PunchResolution = require('./PunchResolution');
const PunchEntryTask = require('./PunchEntryTask');
const ExternalEnrollment = require('./ExternalEnrollment');
const TmtApproval = require('./TmtApproval');
const EnrollmentImport = require('./EnrollmentImport');
const ScannedAttachment = require('./ScannedAttachment');
const ParentAccount = require('./ParentAccount');
const ParentPortalChange = require('./ParentPortalChange');
const DailyLog = require('./DailyLog');
const DailyMenu = require('./DailyMenu');
const Photo = require('./Photo');
const GiftCampaign = require('./GiftCampaign');
const GiftSelection = require('./GiftSelection');
const Candidate = require('./Candidate');

const real = {
  PayrollRollup,
  User,
  Branch,
  Classroom,
  Registration,
  Child,
  Collection,
  Archive,
  Document,
  CollectionHistory,
  PriceAdjustment,
  SalaryRequest,
  Holiday,
  Activity,
  Discount,
  GanttMonth,
  Supplier,
  Product,
  Order,
  Amuta,
  Employee,
  Punch,
  AgentCommand,
  Contract,
  ContractVersion,
  EmployeeRequest,
  StockCategory,
  StockItem,
  StockMovement,
  StockBatch,
  PayslipAuditRecord,
  PayslipAuditPdf,
  SavedPayslip,
  DirectPayslipBatch,
  HoursDistributionLog,
  PayrollMonth,
  PayrollPresetOption,
  PayrollCustomColumn,
  SalaryAdjustment,
  EmployeeCommitment,
  PayrollChangeRequest,
  BranchPricing,
  SummerCamp,
  EmployeeLetter,
  EmploymentContract,
  ContractAnnex,
  SpecialDay,
  CibusSync,
  EmployeeDocument,
  Form101Sync,
  Form101Inbox,
  Setting,
  ClassProvider,
  ClassProgram,
  ClassSession,
  MaintenanceItem,
  EmployeeChangeRequest,
  GanEvent,
  Lead,
  PunchResolution,
  PunchEntryTask,
  ExternalEnrollment,
  TmtApproval,
  EnrollmentImport,
  ScannedAttachment,
  ParentAccount,
  ParentPortalChange,
  DailyLog,
  DailyMenu,
  Photo,
  GiftCampaign,
  GiftSelection,
  Candidate,
  Announcement,
  SmsBudget,
  Absence,
  PickupAuthorization,
};


// ---------------------------------------------------------------------------
// One customer's models, or everyone's.
//
// With no PLATFORM_MONGODB_URI this file exports the real models compiled
// against the ordinary connection, exactly as it always has. `real` is what
// leaves, and nothing below runs.
//
// On a control plane it exports a stand-in per model instead. A controller
// still writes `const { Child } = require('../models')` and still holds that
// value forever — but `Child.find` is looked up when the query is made, and
// answered from the customer the current request resolved to. The 95,000 lines
// above this comment never learn that customers exist.
//
// Reaching a query with no customer in scope THROWS. It would be easy to fall
// back to the default connection and it is the one thing that must not happen:
// that is the shape of serving one gan the contents of another.
const { platformMode, currentModels } = require('../platform/context');

function standIn(name) {
  const pick = () => {
    const models = currentModels();
    if (!models) {
      throw new Error(
        `נגישה למודל ${name} מחוץ להקשר של לקוח. ` +
        'על שרת פלטפורמה כל שאילתה חייבת לרוץ בתוך בקשה שזוהה לה לקוח.'
      );
    }
    const M = models[name];
    if (!M) throw new Error(`המודל ${name} אינו קיים אצל הלקוח הנוכחי`);
    return M;
  };
  return new Proxy(function () {}, {
    get: (_t, prop) => (prop === '__isStandIn' ? true : pick()[prop]),
    set: (_t, prop, value) => { pick()[prop] = value; return true; },
    has: (_t, prop) => prop in pick(),
    construct: (_t, args) => new (pick())(...args),
    apply: (_t, thisArg, args) => pick().apply(thisArg, args),
  });
}

const exported = platformMode()
  ? Object.fromEntries(Object.keys(real).map((name) => [name, standIn(name)]))
  : { ...real };

// bindModels() needs the real schemas to compile a customer's copies, and a
// stand-in cannot answer `.schema` — there is no customer yet when it asks.
Object.defineProperty(exported, '__real', { value: real, enumerable: false });

module.exports = exported;
