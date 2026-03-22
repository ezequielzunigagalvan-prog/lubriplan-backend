import { technicians } from "../data/technicians.mock.js";

export function getAllTechnicians() {
  return technicians;
}

export function getActiveTechnicians() {
  return technicians.filter(t => t.active);
}

export function getTechnicianById(id) {
  return technicians.find(t => t.id === Number(id));
}