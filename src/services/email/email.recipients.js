import { dedupeEmails } from "./email.utils.js";

function splitExtraEmails(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
}

export async function getPlantAlertRecipients({
  prisma,
  plantId,
  roles = ["ADMIN", "SUPERVISOR"],
  includeExtraPlantRecipients = false,
}) {
  if (!plantId) return [];

  const users = await prisma.user.findMany({
    where: {
      active: true,
      email: { not: "" },
      role: { in: roles },
      userPlants: {
        some: {
          plantId: Number(plantId),
          active: true,
        },
      },
    },
    select: {
      email: true,
      role: true,
      name: true,
    },
  });

  let emails = users.map((u) => u.email);

  if (includeExtraPlantRecipients) {
    const plant = await prisma.plant.findUnique({
      where: { id: Number(plantId) },
      select: {
        monthlyReportRecipientsExtra: true,
      },
    });

    const extra = splitExtraEmails(plant?.monthlyReportRecipientsExtra);
    emails = [...emails, ...extra];
  }

  return dedupeEmails(emails);
}