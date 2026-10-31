import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Track,
  Playlist,
  Album,
  Artist,
  LibraryData,
  LocalPlaylist,
} from '@pterosaur/shared/types'
import { keyOf } from '@pterosaur/shared/types'
import { libraryStorage } from '../lib/libraryStorage.js'

export type { LocalPlaylist }

/** 资料库数据字段（收藏 / 最近 / 自建歌单 / 收藏的网易云歌单 · 专辑），亦即云同步载荷。 */
export type LibraryState = LibraryData

interface LibraryActions {
  toggleFavorite: (track: Track) => void
  isFavorite: (track: Track) => boolean
  addRecent: (track: Track) => void
  clearRecent: () => void
  createPlaylist: (name: string, tracks?: Track[]) => string
  deletePlaylist: (id: string) => void
  renamePlaylist: (id: string, name: string) => void
  addToPlaylist: (playlistId: string, track: Track) => void
  removeFromPlaylist: (playlistId: string, track: Track) => void
  toggleSavePlaylist: (playlist: Playlist) => void
  toggleSaveArtist: (artist: Artist) => void
  toggleSaveAlbum: (album: Album) => void
}

export type LibraryStore = LibraryState & LibraryActions

const MAX_RECENT = 100

function genId(): string {
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export const useLibrary = create<LibraryStore>()(
  persist(
    (set, get) => ({
      favorites: [],
      recent: [],
      playlists: [],
      savedPlaylists: [],
      savedArtists: [],
      savedAlbums: [],

      toggleFavorite: (track) =>
        set((s) => {
          const exists = s.favorites.some((t) => keyOf(t) === keyOf(track))
          return {
            favorites: exists
              ? s.favorites.filter((t) => keyOf(t) !== keyOf(track))
              : [track, ...s.favorites],
          }
        }),

      isFavorite: (track) =>
        get().favorites.some((t) => keyOf(t) === keyOf(track)),

      addRecent: (track) =>
        set((s) =>
          // 多数情况下刚播完切下一首，同一个 key 必然排在首位——此时不产生新快照，
          // 免得每次切歌都让 library 落盘一次（播放即保存后切歌会有额外写）
          s.recent[0] && keyOf(s.recent[0]) === keyOf(track)
            ? s
            : {
                recent: [
                  track,
                  ...s.recent.filter((t) => keyOf(t) !== keyOf(track)),
                ].slice(0, MAX_RECENT),
              },
        ),

      clearRecent: () => set({ recent: [] }),

      createPlaylist: (name, tracks = []) => {
        const id = genId()
        set((s) => ({
          playlists: [
            ...s.playlists,
            { id, name: name || '新建歌单', createdAt: Date.now(), tracks },
          ],
        }))
        return id
      },

      deletePlaylist: (id) =>
        set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) })),

      renamePlaylist: (id, name) =>
        set((s) => ({
          playlists: s.playlists.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      addToPlaylist: (playlistId, track) =>
        set((s) => ({
          playlists: s.playlists.map((p) =>
            p.id === playlistId &&
            !p.tracks.some((t) => keyOf(t) === keyOf(track))
              ? { ...p, tracks: [...p.tracks, track] }
              : p,
          ),
        })),

      removeFromPlaylist: (playlistId, track) =>
        set((s) => ({
          playlists: s.playlists.map((p) =>
            p.id === playlistId
              ? {
                  ...p,
                  tracks: p.tracks.filter((t) => keyOf(t) !== keyOf(track)),
                }
              : p,
          ),
        })),

      toggleSavePlaylist: (playlist) =>
        set((s) => {
          const exists = s.savedPlaylists.some(
            (p) => keyOf(p) === keyOf(playlist),
          )
          return {
            savedPlaylists: exists
              ? s.savedPlaylists.filter((p) => keyOf(p) !== keyOf(playlist))
              : [playlist, ...s.savedPlaylists],
          }
        }),

      toggleSaveArtist: (artist) =>
        set((s) => {
          const exists = s.savedArtists.some((a) => keyOf(a) === keyOf(artist))
          return {
            savedArtists: exists
              ? s.savedArtists.filter((a) => keyOf(a) !== keyOf(artist))
              : [artist, ...s.savedArtists],
          }
        }),

      toggleSaveAlbum: (album) =>
        set((s) => {
          const exists = s.savedAlbums.some((a) => keyOf(a) === keyOf(album))
          return {
            savedAlbums: exists
              ? s.savedAlbums.filter((a) => keyOf(a) !== keyOf(album))
              : [album, ...s.savedAlbums],
          }
        }),
    }),
    {
      name: 'pterosaur-library',
      storage: libraryStorage,
      // 仅持久化数据字段：IDB 的 structured clone 无法克隆 action 函数（会抛 DataCloneError）
      partialize: (s) => ({
        favorites: s.favorites,
        recent: s.recent,
        playlists: s.playlists,
        savedPlaylists: s.savedPlaylists,
        savedArtists: s.savedArtists,
        savedAlbums: s.savedAlbums,
      }),
      // 迁移到异步 IDB 后，hydration 不再是同步的：由 main.tsx 在首次渲染前手动 rehydrate，
      // 消除「库为空」的闪烁。
      skipHydration: true,
    },
  ),
)
