import { supabase } from "../storage/supabaseClient.js";
import { rowToProject, projectToRowPatch, type ProjectRow } from "../storage/rowMappers.js";
import { deleteAssetPrefix } from "../storage/assetStorage.js";
import { STAGE_ORDER, type Project, type ProjectStage, type VideoDimension } from "../models/index.js";

export class StageGateError extends Error {
  constructor(current: ProjectStage, required: ProjectStage) {
    super(`Action requires stage "${required}" or later, but project is at "${current}"`);
    this.name = "StageGateError";
  }
}

export function assertStageAtLeast(project: Project, required: ProjectStage): void {
  const currentIdx = STAGE_ORDER.indexOf(project.stage);
  const requiredIdx = STAGE_ORDER.indexOf(required);
  if (currentIdx < requiredIdx) {
    throw new StageGateError(project.stage, required);
  }
}

export async function createProject(name: string, dimension: VideoDimension = "YOUTUBE_16_9"): Promise<Project> {
  const { data, error } = await supabase
    .from("projects")
    .insert({ name, dimension })
    .select()
    .single();
  if (error) throw error;
  return rowToProject(data as ProjectRow);
}

export async function getProject(id: string): Promise<Project | null> {
  const { data, error } = await supabase.from("projects").select().eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return rowToProject(data as ProjectRow);
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select()
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as ProjectRow[]).map(rowToProject);
}

export async function saveProject(project: Project): Promise<Project> {
  const patch = projectToRowPatch(project);
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", project.id)
    .select()
    .single();
  if (error) throw error;
  return rowToProject(data as ProjectRow);
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw error;
  await deleteAssetPrefix(id);
}

export function advanceStage(project: Project, next: ProjectStage): void {
  const currentIdx = STAGE_ORDER.indexOf(project.stage);
  const nextIdx = STAGE_ORDER.indexOf(next);
  if (nextIdx < currentIdx) {
    throw new Error(`Cannot move project stage backwards from "${project.stage}" to "${next}"`);
  }
  project.stage = next;
}
