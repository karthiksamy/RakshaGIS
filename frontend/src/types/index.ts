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

export const ADMIN_ROLES: UserRole[] = ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN']

export interface User {
  id: number
  username: string
  first_name: string
  last_name: string
  email: string
  full_name: string
  employee_id: string
  role: UserRole
  organisation: number | null
  organisation_name: string
  organisation_level?: OrgLevel
  organisation_level_display?: string
  phone: string
  designation: string
  is_active: boolean
  password?: string
}

export interface Organisation {
  id: number
  name: string
  code: string
  level: OrgLevel
  level_display: string
  parent: number | null
  parent_name: string
  address: string
  default_basemap: number | null
  office_id: string
  officer_name: string
  mobile: string
  landline: string
  email: string
  state: number | null
  state_name: string
  district: number | null
  district_name: string
  pincode: string
  created_at: string
}

export interface MasterState {
  id: number
  name: string
  code: string
}

export interface MasterDistrict {
  id: number
  name: string
  code: string
  state: number
  state_name: string
}

export interface MasterTaluk {
  id: number
  name: string
  code: string
  district: number
  district_name: string
}

export interface MasterVillage {
  id: number
  name: string
  code: string
  taluk: number
  taluk_name: string
}

export type FolderType = 'COMMON' | 'BOUNDARY' | 'PHASE' | 'ZONE' | 'YEAR' | 'VERSION' | 'DOC' | 'SHAPEFILE' | 'RASTER' | 'OTHERS'

export interface ProjectLayerFolder {
  id: number
  project: number
  parent: number | null
  name: string
  folder_type: FolderType
  folder_type_display: string
  year: number | null
  is_final: boolean
  order: number
  created_by: number | null
  created_at: string
  children: ProjectLayerFolder[]
}

export interface ProjectShare {
  id: number
  project: number
  project_name: string
  granted_to: number
  granted_to_name: string
  granted_by: number | null
  created_at: string
}

export type ProjectStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'RETURNED'

export interface SurveyArea {
  id: number
  project: number
  name: string
  area_code: string
  description: string
  folder: number | null
  folder_name: string
  assigned_to: number | null
  assigned_to_name: string
  status: ProjectStatus
  status_display: string
  map_enabled?: boolean
  created_by: number | null
  created_by_name: string
  created_at: string
  updated_at: string
}

export interface SurveyProject {
  id: number
  name: string
  description: string
  organisation: number
  organisation_name: string
  status: ProjectStatus
  map_enabled?: boolean
  created_by: number
  created_by_name: string
  created_at: string
  updated_at: string
}

export interface GISFeature {
  id: number
  project: number
  folder: number | null
  feature_id: string
  layer_name: string
  geometry_type: string
  geometry: Record<string, unknown>
  attributes: Record<string, unknown>
  is_deleted: boolean
  created_by: number | null
  created_by_name: string
  created_at: string
  updated_at: string
}

export interface LayerStyle {
  color: string
  showLabels: boolean
  opacity: number
}

export interface MapBookmark {
  id: string
  name: string
  center: [number, number]
  zoom: number
}

export interface TopoIssue {
  type: 'INVALID_GEOMETRY' | 'OVERLAP'
  parcel_a: { id: number; parcel_id: string; name: string }
  parcel_b?: { id: number; parcel_id: string; name: string }
  centroid?: Record<string, unknown> | null
}

export interface Document {
  id: number
  project: number
  folder: number | null
  folder_name: string
  title: string
  file: string
  file_url: string | null
  category: string
  category_display: string
  mime_type: string
  file_size: number
  ai_processed: boolean
  ai_summary: string
  uploaded_by: number
  uploaded_by_name: string
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

export interface SurveyAreaDiscovery {
  id: number
  name: string
  area_code: string
  status: string
  project_id: number
  project_name: string
  org_id: number
  org_name: string
  org_level: string
  access_status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
}

export interface SurveyAreaAccessRequest {
  id: number
  survey_area: number
  survey_area_name: string
  project_name: string
  project_id: number
  requested_by: number
  requested_by_name: string
  requesting_org: number
  requesting_org_name: string
  target_org_name: string
  reason: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  status_display: string
  reviewed_by: number | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  review_remarks: string
  created_at: string
}

export interface BrandingConfig {
  app_title: string
  app_subtitle: string
  login_tagline: string
  primary_color: string
  logo_url: string
}

export type BasemapProvider = 'OSM' | 'XYZ' | 'WMS' | 'WMTS' | 'BING' | 'BHUVAN'

export interface BasemapConfig {
  id: number
  name: string
  provider: BasemapProvider
  url_template: string
  attribution: string
  is_active: boolean
  is_default: boolean
  is_system: boolean
}

export interface ChatMessage {
  id: number
  role: 'USER' | 'ASSISTANT'
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
  error_message: string
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

export interface QGISUploadLog {
  id: number
  project: number
  project_number: string
  folder: number | null
  folder_name: string
  filename: string
  original_path: string
  file_size: number
  algorithm_id: string
  module_name: string
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  error_message: string
  uploaded_by: number | null
  uploaded_by_name: string
  uploaded_at: string
}

export interface ShapefileImport {
  id: number
  project: number
  folder: number | null
  folder_name: string | null
  layer_name: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  status_display: string
  feature_count: number | null
  columns: string[]
  error: string
  ai_processed: boolean
  ai_summary: string
  created_by: number | null
  created_by_name: string
  created_at: string
}

export interface GeoTiffLayer {
  id: number
  project: number
  folder: number | null
  folder_name: string
  name: string
  file: string
  cog_file: string
  cog_url: string | null
  status: 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED'
  status_display: string
  error: string
  is_visible: boolean
  opacity: number
  created_by: number | null
  created_by_name: string
  created_at: string
}

export interface BufferParcel {
  id: number
  parcel_id: string
  name: string
  category: string
  category_display: string
  classification: string
  classification_display: string
  area_hectares: string
  state_name: string
  district_name: string
  organisation_name: string
  geometry: Record<string, unknown>
}

export interface BufferSurveyArea {
  area_id: number | null
  area_name: string | null
  area_code: string | null
  status: string | null
  status_display: string | null
  project_id: number
  project_name: string
  organisation: string
  feature_count: number
  layers: string[]
}

export interface BufferRingResult {
  distance: number
  unit: 'meters' | 'kilometers'
  distance_m: number
  buffer_geojson: Record<string, unknown>
  parcels: BufferParcel[]
  survey_areas: BufferSurveyArea[]
  survey_area_count: number
}

export type TempLayerFormat = 'kml' | 'kmz' | 'geojson' | 'shapefile'

export interface TemporaryLayer {
  id: number
  name: string
  purpose: string
  description: string
  file_format: TempLayerFormat
  file_format_display: string
  file: string
  geojson: Record<string, unknown> | null
  feature_count: number
  uploaded_by: number
  uploaded_by_name: string
  created_at: string
}

export interface PaginatedResponse<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}
