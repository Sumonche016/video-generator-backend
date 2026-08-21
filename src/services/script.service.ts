import { getLLMProvider } from "../config/providers.config.js";
import { supabase } from "../storage/supabaseClient.js";
import { getProject, saveProject, advanceStage, assertStageAtLeast } from "./project.service.js";
import {
  CHARACTER_EXTRACTION_SYSTEM_PROMPT,
  buildCharacterExtractionUserMessage,
  parseCharacterExtractionResponse,
} from "../prompt-templates/characterExtraction.template.js";
import { slugify } from "../utils/slug.js";
import type { Character, Project } from "../models/index.js";

export async function uploadScriptAndExtractCharacters(
  projectId: string,
  scriptText: string
): Promise<{ project: Project; characters: Character[] }> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  assertStageAtLeast(project, "PRODUCT_UNDERSTOOD");

  const llm = getLLMProvider();
  const result = await llm.chat({
    systemPrompt: CHARACTER_EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildCharacterExtractionUserMessage(scriptText, project.product.understandingSummary),
      },
    ],
    responseFormat: "json",
  });

  const extracted = parseCharacterExtractionResponse(result.text);

  // Re-running script analysis on a project that already has characters must
  // not crash (duplicate slug) or wipe out approval/bible progress already
  // made on existing characters — only insert genuinely new ones.
  const existing = await listCharacters(projectId);
  const existingSlugs = new Set(existing.map((c) => c.slug));

  const newRows = extracted
    .filter((c) => !existingSlugs.has(slugify(c.name)))
    .map((c) => ({
      project_id: projectId,
      name: c.name.trim(),
      slug: slugify(c.name),
      description: c.description ?? "",
      source: "ai" as const,
      approved: false,
    }));

  let inserted: Character[] = [];
  if (newRows.length > 0) {
    const { data, error } = await supabase.from("characters").insert(newRows).select();
    if (error) throw error;
    inserted = (data ?? []).map(mapCharacterRow);
  }

  project.script = { text: scriptText, status: "analyzed" };
  advanceStage(project, "SCRIPT_ANALYZED");
  const savedProject = await saveProject(project);

  return { project: savedProject, characters: [...existing, ...inserted] };
}

export async function deleteCharacter(projectId: string, characterId: string): Promise<void> {
  const { error } = await supabase
    .from("characters")
    .delete()
    .eq("id", characterId)
    .eq("project_id", projectId);
  if (error) throw error;
}

export async function listCharacters(projectId: string): Promise<Character[]> {
  const { data, error } = await supabase
    .from("characters")
    .select()
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapCharacterRow);
}

export async function addCharacter(
  projectId: string,
  name: string,
  description: string
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .insert({
      project_id: projectId,
      name,
      slug: slugify(name),
      description,
      source: "human-added",
      approved: true,
    })
    .select()
    .single();
  if (error) throw error;
  return mapCharacterRow(data);
}

export async function setCharacterApproval(
  projectId: string,
  characterId: string,
  approved: boolean
): Promise<Character> {
  const { data, error } = await supabase
    .from("characters")
    .update({ approved })
    .eq("id", characterId)
    .eq("project_id", projectId)
    .select()
    .single();
  if (error) throw error;
  return mapCharacterRow(data);
}

export async function confirmApprovedCharacters(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  advanceStage(project, "CHARACTERS_APPROVED");
  return saveProject(project);
}

function mapCharacterRow(row: {
  id: string;
  name: string;
  slug: string;
  description: string;
  source: "ai" | "human-added";
  approved: boolean;
  bible: Character["bible"];
}): Character {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    source: row.source,
    approved: row.approved,
    bible: row.bible,
  };
}
