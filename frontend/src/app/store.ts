import { create } from 'zustand'
import type { User, BasemapConfig } from '@/types'

interface AppState {
  user: User | null
  setUser: (user: User | null) => void

  selectedProjectId: number | null
  setSelectedProjectId: (id: number | null) => void

  selectedFeatureId: number | null
  setSelectedFeatureId: (id: number | null) => void

  activeBasemap: BasemapConfig | null
  setActiveBasemap: (bm: BasemapConfig | null) => void

  sidebarTab: 'layers' | 'projects' | 'documents' | 'chat'
  setSidebarTab: (tab: AppState['sidebarTab']) => void

  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void

  mapTool: 'pan' | 'identify' | 'measure' | 'buffer' | 'box_select' | 'select_location' | 'coord_picker'
    | 'draw_point' | 'draw_line' | 'draw_polygon'
    | 'vertex_tool' | 'edit_features'
    | 'move_feature' | 'copy_move' | 'rotate_feature' | 'scale_feature' | 'simplify_feature'
    | 'add_part' | 'delete_part' | 'reshape_feature' | 'offset_curve' | 'reverse_line'
    | 'trim_extend' | 'split_feature' | 'split_parts' | 'merge_features' | 'merge_attributes'
    | 'delete_feature'
  setMapTool: (tool: AppState['mapTool']) => void

  mapCoords: [number, number] | null
  setMapCoords: (coords: [number, number] | null) => void

  selectedFolderId: number | null
  setSelectedFolderId: (id: number | null) => void
}

const LAST_PROJECT_KEY = 'rakshagis-last-project'

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  selectedProjectId: (() => {
    const v = localStorage.getItem(LAST_PROJECT_KEY)
    return v ? Number(v) : null
  })(),
  setSelectedProjectId: (id) => {
    if (id !== null) localStorage.setItem(LAST_PROJECT_KEY, String(id))
    else localStorage.removeItem(LAST_PROJECT_KEY)
    set({ selectedProjectId: id })
  },

  selectedFeatureId: null,
  setSelectedFeatureId: (id) => set({ selectedFeatureId: id }),

  activeBasemap: null,
  setActiveBasemap: (bm) => set({ activeBasemap: bm }),

  sidebarTab: 'projects',
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  mapTool: 'pan',
  setMapTool: (tool) => set({ mapTool: tool }),

  mapCoords: null,
  setMapCoords: (coords) => set({ mapCoords: coords }),

  selectedFolderId: null,
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
}))
