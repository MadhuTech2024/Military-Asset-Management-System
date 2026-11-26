import { DEMO_USERS } from "../auth/demoUsers.js";

export const DEMO_BASE_IDS = Object.freeze([
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
]);

export const DEMO_TYPE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) =>
    `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
  ),
);

const BASE_DEFINITIONS = [
  ["NSB", "Northstar Operations Base", "Northern District"],
  ["RVB", "Rivermark Support Base", "River District"],
  ["HGB", "Highland Readiness Base", "Highland District"],
  ["EGB", "Eastgate Logistics Base", "Eastern District"],
  ["WFB", "Westfield Training Base", "Western District"],
];

const TYPE_DEFINITIONS = [
  ["COM-01", "Field radio", "Communications"],
  ["COM-02", "Portable repeater", "Communications"],
  ["TRN-01", "Utility vehicle", "Transport"],
  ["TRN-02", "Cargo truck", "Transport"],
  ["MED-01", "Trauma kit", "Medical"],
  ["MED-02", "Portable monitor", "Medical"],
  ["ENG-01", "Power generator", "Engineering"],
  ["ENG-02", "Water pump", "Engineering"],
  ["PRT-01", "Protective helmet", "Protective gear"],
  ["PRT-02", "Protective vest", "Protective gear"],
  ["SUP-01", "Field shelter", "Field supplies"],
  ["SUP-02", "Portable lighting set", "Field supplies"],
];

const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const daysAgo = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const addDays = (date, days) =>
  new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000).toISOString();

export function createInitialDemoData() {
  const bases = BASE_DEFINITIONS.map(([code, name, region], index) => ({
    id: DEMO_BASE_IDS[index],
    code,
    name,
    region,
    location: region,
    locationName: region,
    isActive: true,
    createdAt: daysAgo(400 - index * 12),
    updatedAt: daysAgo(20 + index),
  }));
  const equipmentTypes = TYPE_DEFINITIONS.map(
    ([code, name, category], index) => ({
      id: DEMO_TYPE_IDS[index],
      code,
      name,
      category,
      description: `Synthetic ${name.toLowerCase()} assigned for local demonstration.`,
      isActive: true,
      createdAt: daysAgo(300 - index * 8),
      updatedAt: daysAgo(15 + index),
    }),
  );
  const inventoryPositions = bases.flatMap((base, baseIndex) =>
    equipmentTypes.map((equipmentType, typeIndex) => ({
      id: id(200 + baseIndex * equipmentTypes.length + typeIndex),
      baseId: base.id,
      equipmentTypeId: equipmentType.id,
      openingBalance: 80 + baseIndex * 11 + typeIndex * 5,
      openingAt: daysAgo(240),
      isActive: true,
    })),
  );
  const users = DEMO_USERS.map((user, index) => ({
    ...user,
    isDemoAccount: true,
    createdAt: daysAgo(90 + index * 5),
    updatedAt: daysAgo(7 + index),
  }));
  const personnelNames = [
    ["Avery Morgan", "Captain", "Operations"],
    ["Jordan Ellis", "Lieutenant", "Logistics"],
    ["Riley Bennett", "Sergeant", "Communications"],
    ["Casey Brooks", "Corporal", "Transport"],
    ["Taylor Reed", "Specialist", "Medical"],
    ["Morgan Hayes", "Sergeant", "Engineering"],
    ["Quinn Parker", "Lieutenant", "Readiness"],
    ["Jamie Foster", "Corporal", "Logistics"],
    ["Cameron Blake", "Specialist", "Communications"],
    ["Drew Sullivan", "Captain", "Operations"],
    ["Peyton Ross", "Sergeant", "Medical"],
    ["Skyler Ward", "Corporal", "Transport"],
    ["Robin Hayes", "Specialist", "Engineering"],
    ["Emerson Cole", "Lieutenant", "Readiness"],
    ["Reese Jordan", "Sergeant", "Logistics"],
  ];
  const personnel = personnelNames.map(([fullName, rank, unit], index) => {
    const baseIndex = index % bases.length;
    return {
      id: id(300 + index),
      fullName,
      serviceNumber: `SYN-${String(index + 1).padStart(4, "0")}`,
      rank,
      unit,
      baseId: bases[baseIndex].id,
      email: `personnel${index + 1}@demo.example.com`,
      phone: `555-01${String(index + 1).padStart(2, "0")}`,
      status: index === 14 ? "ON_LEAVE" : "ACTIVE",
      assignedAt: daysAgo(180 - index * 3),
    };
  });

  const purchaseDefinitions = [
    [0, 0, 24, "COMPLETED", 172, "PO-SYN-2401", "Northwind Supply"],
    [1, 2, 3, "PENDING", 160, "PO-SYN-2402", "Meridian Mobility"],
    [2, 6, 2, "COMPLETED", 140, "PO-SYN-2403", "Beacon Industrial"],
    [3, 10, 18, "PENDING", 126, "PO-SYN-2404", "Summit Field Goods"],
    [4, 8, 30, "APPROVED", 105, "PO-SYN-2405", "Civic Equipment Co."],
    [0, 4, 12, "COMPLETED", 85, "PO-SYN-2406", "Harbor Medical Supply"],
    [2, 1, 5, "REJECTED", 70, "PO-SYN-2407", "Northwind Supply"],
    [3, 3, 4, "PENDING", 42, "PO-SYN-2408", "Meridian Mobility"],
    [1, 11, 9, "PENDING", 21, "PO-SYN-2409", "Summit Field Goods"],
    [4, 5, 6, "COMPLETED", 12, "PO-SYN-2410", "Harbor Medical Supply"],
  ];
  const purchases = purchaseDefinitions.map(
    ([baseIndex, typeIndex, quantity, status, age, referenceCode, supplier], index) => {
      const purchasedAt = daysAgo(age);
      return {
        id: id(400 + index),
        baseId: bases[baseIndex].id,
        equipmentTypeId: equipmentTypes[typeIndex].id,
        quantity,
        status,
        referenceCode,
        supplier,
        estimatedCost: quantity * (120 + typeIndex * 85),
        purchasedAt,
        completedAt: status === "COMPLETED" ? addDays(purchasedAt, 3) : null,
        expectedAt: status === "PENDING" || status === "APPROVED" ? addDays(purchasedAt, 14) : null,
        createdBy: users[index % users.length].id,
        notes: "Synthetic demo procurement record.",
      };
    },
  );

  const transferDefinitions = [
    [0, 1, 0, 5, 150, "COMPLETED"],
    [1, 2, 2, 7, 140, "PENDING"],
    [2, 3, 6, 3, 125, "COMPLETED"],
    [3, 4, 10, 4, 110, "APPROVED"],
    [4, 0, 8, 6, 95, "REJECTED"],
    [0, 2, 4, 2, 80, "PENDING"],
    [1, 3, 3, 8, 60, "COMPLETED"],
    [4, 1, 1, 4, 45, "REJECTED"],
    [2, 0, 9, 3, 20, "PENDING"],
    [3, 1, 11, 5, 10, "COMPLETED"],
  ];
  const transfers = transferDefinitions.map(
    ([sourceIndex, destinationIndex, typeIndex, quantity, age, status], index) => {
      const createdAt = daysAgo(age);
      return {
        id: id(500 + index),
        sourceBaseId: bases[sourceIndex].id,
        destinationBaseId: bases[destinationIndex].id,
        equipmentTypeId: equipmentTypes[typeIndex].id,
        quantity,
        status,
        createdAt,
        approvedAt: status === "APPROVED" || status === "COMPLETED" ? addDays(createdAt, 1) : null,
        completedAt: status === "COMPLETED" ? addDays(createdAt, 2) : null,
        rejectedAt: status === "REJECTED" ? addDays(createdAt, 1) : null,
        initiatedBy: users[index % users.length].id,
        notes: "Synthetic inter-base transfer.",
      };
    },
  );

  const assignments = Array.from({ length: 12 }, (_, index) => {
    const baseIndex = index % bases.length;
    const typeIndex = (index * 2 + 3) % equipmentTypes.length;
    const grossAssigned = 3 + (index % 5);
    const cumulativeReturned = index % 3 === 0 ? 0 : 1 + (index % 2);
    const asset = inventoryPositions.find(
      (position) =>
        position.baseId === bases[baseIndex].id &&
        position.equipmentTypeId === equipmentTypes[typeIndex].id,
    );
    return {
      id: id(600 + index),
      assetId: asset.id,
      baseId: bases[baseIndex].id,
      equipmentTypeId: equipmentTypes[typeIndex].id,
      grossAssigned,
      cumulativeReturned,
      netAssigned: grossAssigned - cumulativeReturned,
      status: cumulativeReturned === grossAssigned ? "RETURNED" : "ACTIVE",
      assignedAt: daysAgo(160 - index * 10),
      personnelReference: personnel[index].serviceNumber,
      personnelId: personnel[index].id,
      createdBy: users[index % users.length].id,
      notes: "Synthetic personnel issue.",
    };
  });
  const returns = assignments
    .filter((assignment) => assignment.cumulativeReturned > 0)
    .map((assignment, index) => ({
      id: id(900 + index),
      assignmentId: assignment.id,
      assetId: assignment.assetId,
      baseId: assignment.baseId,
      equipmentTypeId: assignment.equipmentTypeId,
      quantity: assignment.cumulativeReturned,
      returnedAt: daysAgo(65 - index * 5),
      returnedBy: users[index % users.length].id,
    }));

  const expenditures = Array.from({ length: 9 }, (_, index) => {
    const baseIndex = (index * 2) % bases.length;
    const typeIndex = (index + 1) % equipmentTypes.length;
    const asset = inventoryPositions.find(
      (position) =>
        position.baseId === bases[baseIndex].id &&
        position.equipmentTypeId === equipmentTypes[typeIndex].id,
    );
    return {
      id: id(700 + index),
      expenditureId: id(700 + index),
      assetId: asset.id,
      baseId: bases[baseIndex].id,
      equipmentTypeId: equipmentTypes[typeIndex].id,
      quantity: 1 + (index % 4),
      reasonCode: ["CONSUMED", "DAMAGED", "TRAINING", "EXPIRED"][index % 4],
      notes: "Synthetic demo expenditure.",
      expendedAt: daysAgo(150 - index * 15),
      createdBy: users[index % users.length].id,
    };
  });

  const auditTemplates = [
    ["PURCHASE_CREATED", "purchase", 400, 0],
    ["PURCHASE_COMPLETED", "purchase", 400, 0],
    ["TRANSFER_INITIATED", "transfer", 500, 0],
    ["TRANSFER_COMPLETED", "transfer", 500, 1],
    ["TRANSFER_APPROVED", "transfer", 503, 4],
    ["ASSIGNMENT_CREATED", "assignment", 600, 0],
    ["ASSIGNMENT_RETURN_RECORDED", "return_operation", 600, 0],
    ["EXPENDITURE_RECORDED", "expenditure", 700, 0],
    ["BASE_UPDATED", "base", 10, 0],
    ["EQUIPMENT_TYPE_UPDATED", "equipment_type", 100, 1],
    ["USER_UPDATED", "user", 2, 0],
    ["PURCHASE_CREATED", "purchase", 401, 1],
    ["TRANSFER_REJECTED", "transfer", 504, 4],
    ["ASSIGNMENT_CREATED", "assignment", 605, 0],
    ["EXPENDITURE_RECORDED", "expenditure", 704, 4],
    ["TRANSFER_INITIATED", "transfer", 508, 2],
    ["PURCHASE_COMPLETED", "purchase", 402, 2],
    ["ASSIGNMENT_RETURN_RECORDED", "return_operation", 603, 3],
    ["USER_ACTIVATED", "user", 1, 1],
    ["OPENING_STOCK_CREATED", "inventory_position", 200, 0],
  ];
  const auditLogs = auditTemplates.map(
    ([action, entityType, entityNumber, baseIndex], index) => ({
      id: id(800 + index),
      action,
      entityType,
      entityId:
        entityType === "base"
          ? DEMO_BASE_IDS[entityNumber - 10]
          : entityType === "equipment_type"
            ? DEMO_TYPE_IDS[entityNumber - 100]
            : entityType === "inventory_position"
              ? inventoryPositions[0].id
              : id(entityNumber),
      actorId: users[index % users.length].id,
      baseId: baseIndex === null ? null : bases[baseIndex].id,
      correlationId: `demo-correlation-${String(index + 1).padStart(3, "0")}`,
      createdAt: daysAgo(45 - index * 2),
      metadata: { synthetic: true, source: "local-demo" },
    }),
  );

  return {
    bases,
    equipmentTypes,
    inventoryPositions,
    users,
    personnel,
    purchases,
    transfers,
    assignments,
    returns,
    expenditures,
    auditLogs,
  };
}

export function calculatePosition(data, position) {
  const completedPurchases = data.purchases
    .filter(
      (purchase) =>
        purchase.status === "COMPLETED" &&
        purchase.baseId === position.baseId &&
        purchase.equipmentTypeId === position.equipmentTypeId,
    )
    .reduce((total, purchase) => total + purchase.quantity, 0);
  const completedTransfersIn = data.transfers
    .filter(
      (transfer) =>
        transfer.status === "COMPLETED" &&
        transfer.destinationBaseId === position.baseId &&
        transfer.equipmentTypeId === position.equipmentTypeId,
    )
    .reduce((total, transfer) => total + transfer.quantity, 0);
  const completedTransfersOut = data.transfers
    .filter(
      (transfer) =>
        transfer.status === "COMPLETED" &&
        transfer.sourceBaseId === position.baseId &&
        transfer.equipmentTypeId === position.equipmentTypeId,
    )
    .reduce((total, transfer) => total + transfer.quantity, 0);
  const matchingAssignments = data.assignments.filter(
    (assignment) => assignment.assetId === position.id,
  );
  const assigned = matchingAssignments.reduce(
    (total, assignment) => total + assignment.netAssigned,
    0,
  );
  const returned = matchingAssignments.reduce(
    (total, assignment) => total + assignment.cumulativeReturned,
    0,
  );
  const expended = data.expenditures
    .filter((entry) => entry.assetId === position.id)
    .reduce((total, entry) => total + entry.quantity, 0);
  const closingBalance =
    position.openingBalance +
    completedPurchases +
    completedTransfersIn -
    completedTransfersOut -
    assigned -
    expended;
  if (closingBalance < 0) {
    throw new Error(`Synthetic inventory position ${position.id} is overdrawn.`);
  }
  return {
    ...position,
    purchases: completedPurchases,
    transfersIn: completedTransfersIn,
    transfersOut: completedTransfersOut,
    assigned,
    returned,
    expended,
    closingBalance,
  };
}

export function getInventoryRows(data, baseId) {
  return data.inventoryPositions
    .filter((position) => !baseId || position.baseId === baseId)
    .map((position) => {
      const base = data.bases.find((entry) => entry.id === position.baseId);
      const equipmentType = data.equipmentTypes.find(
        (entry) => entry.id === position.equipmentTypeId,
      );
      return {
        ...calculatePosition(data, position),
        base,
        equipmentType,
      };
    });
}

