const User = require('./User');
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

module.exports = {
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
};
