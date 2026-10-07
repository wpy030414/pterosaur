import { describe, it, expect, beforeEach } from 'vitest'
import { useLibrary } from '../../src/store/library.js'
import type { Album, Artist, Playlist } from '@pterosaur/shared/types'

const album = (id: string): Album => ({
  source: 'netease',
  id,
  name: `专辑${id}`,
  cover: '',
  artist: '甲',
})
const artist = (id: string): Artist => ({
  source: 'netease',
  id,
  name: `艺人${id}`,
  avatar: '',
})
const playlist = (id: string): Playlist => ({
  source: 'netease',
  id,
  name: `歌单${id}`,
  cover: '',
})

beforeEach(() => {
  useLibrary.setState({
    favorites: [],
    recent: [],
    playlists: [],
    savedPlaylists: [],
    savedArtists: [],
    savedAlbums: [],
  })
})

describe('library store 收藏艺人 / 专辑 / 歌单', () => {
  it('toggleSaveArtist 收藏后置顶、再次调用取消', () => {
    useLibrary.getState().toggleSaveArtist(artist('1'))
    expect(useLibrary.getState().savedArtists.map((a) => a.id)).toEqual(['1'])

    useLibrary.getState().toggleSaveArtist(artist('2'))
    expect(useLibrary.getState().savedArtists.map((a) => a.id)).toEqual([
      '2',
      '1',
    ])

    useLibrary.getState().toggleSaveArtist(artist('1'))
    expect(useLibrary.getState().savedArtists.map((a) => a.id)).toEqual(['2'])
  })

  it('toggleSaveAlbum 收藏后置顶、再次调用取消', () => {
    const s = useLibrary.getState()
    s.toggleSaveAlbum(album('1'))
    expect(useLibrary.getState().savedAlbums.map((a) => a.id)).toEqual(['1'])

    useLibrary.getState().toggleSaveAlbum(album('2'))
    expect(useLibrary.getState().savedAlbums.map((a) => a.id)).toEqual([
      '2',
      '1',
    ])

    useLibrary.getState().toggleSaveAlbum(album('1'))
    expect(useLibrary.getState().savedAlbums.map((a) => a.id)).toEqual(['2'])
  })

  it('toggleSavePlaylist 行为一致（作为对照）', () => {
    useLibrary.getState().toggleSavePlaylist(playlist('9'))
    expect(useLibrary.getState().savedPlaylists.map((p) => p.id)).toEqual(['9'])
    useLibrary.getState().toggleSavePlaylist(playlist('9'))
    expect(useLibrary.getState().savedPlaylists).toEqual([])
  })
})
