export type UserRole =
  | 'SUPERADMIN'
  | 'PDDE_VIEWER'
  | 'VIEWER'
  | 'DEO_ADMIN'
  | 'CEO_ADMIN'
  | 'ADEO_ADMIN'
  | 'SDO'
  | 'SURVEYOR'
  | 'CHECKER'
  | 'APPROVER'

export type OrgLevel = 'DGDE' | 'PDDE' | 'DEO' | 'CEO' | 'ADEO'

export interface User {
  id: number
  username: string
  email: string
  full_name: string
  role: UserRole
  organisation: number | null
  organisation_name: string
  is_active: boolean
}

export interface Organisation {
  id: number
  name: string
  code: string
  level: OrgLevel
  level_display: string
  parent: number | null
  default_basemap: number | null
}

export type ProjectStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'RETURNED'

export interface SurveyProject {
  id: number
  name: string
  description: string
  organisation: number
  organisation_name: string
  status: ProjectStatus
  created_by: number
  created_by_name: string
  created_at: string
  updated_at: string
}

export interface GISFeature {
  id: number
  project: number
  layer_name: string
  geometry: Record<string, unknown>
  properties: Record<string, unknown>
  created_at: string
}

export interface Document {
  id: number
  project: number
  title: string
  file: string
  category: string
  mime_type: string
  file_size: number
  ai_processed: boolean
  ai_summary: string
  uploaded_by: number
  uploaded_at: string
}

export interface WorkflowStep {
  id: number
  project: number
  from_status: string
  to_status: string
  action: string
  performed_by: number
  performed_by_name: string
  comment: string
  timestamp: string
}

export type BasemapProvider = 'OSM' | 'XYZ' | 'WMS' | 'WMTS' | 'BING' | 'BHUVAN'

export interface BasemapConfig {
  id: number
  name: string
  provider: BasemapProvider
  url_template: string
  attribution: string
  is_active: boolean
  is_system: boolean
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface ChatSession {
  id: number
  title: string
  messages: ChatMessage[]
  created_at: string
  updated_at: string
}

export interface AITask {
  id: number
  task_type: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  requested_by: number
  input_data: Record<string, unknown>
  result: Record<string, unknown>
  error: string
  created_at: string
  completed_at: string | null
}

export interface AttributeTemplate {
  id: number
  organisation: number
  layer_name: string
  description: string
  fields: AttributeField[]
}

export interface AttributeField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date'
  required: boolean
  label: string
}

export interface ShapefileImport {
  id: number
  project: number
  layer_name: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  feature_count: number | null
  error: string
  created_at: string
}

export interface PaginatedResponse<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}
