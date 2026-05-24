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

  mapTool: 'pan' | 'identify' | 'draw_point' | 'draw_line' | 'draw_polygon' | 'measure'
  setMapTool: (tool: AppState['mapTool']) => void

  mapCoords: [number, number] | null
  setMapCoords: (coords: [number, number] | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),

  selectedProjectId: null,
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),

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
}))
