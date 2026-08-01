<?php
/**
 * Plugin Name: NoveFlix Stremio Bridge
 * Description: Expõe o catálogo e os players autorizados do NoveFlix para o addon Stremio hospedado externamente.
 * Version: 1.0.0
 * Author: NoveFlix
 * Requires at least: 6.0
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

final class NoveFlix_Stremio_Bridge {
    private const VERSION = '1.0.0';
    private const NAMESPACE = 'noveflix-stremio/v1';

    private static array $categories = [
        'novelas' => ['aliases' => ['novelas', 'novela'], 'type' => 'series', 'genre' => 'Novela', 'episodic' => true],
        'series' => ['aliases' => ['series', 'serie'], 'type' => 'series', 'genre' => 'Série', 'episodic' => true],
        'programas' => ['aliases' => ['programas', 'programa'], 'type' => 'series', 'genre' => 'Programa', 'episodic' => true],
        'shows' => ['aliases' => ['shows', 'show'], 'type' => 'series', 'genre' => 'Show', 'episodic' => true],
        'filmes' => ['aliases' => ['filmes', 'filme'], 'type' => 'movie', 'genre' => 'Filme', 'episodic' => false],
    ];

    public static function boot(): void {
        add_action('rest_api_init', [self::class, 'register_routes']);
        add_action('save_post', [self::class, 'flush_post_cache'], 10, 1);
        add_action('set_object_terms', [self::class, 'flush_post_cache'], 10, 1);
    }

    public static function register_routes(): void {
        register_rest_route(self::NAMESPACE, '/health', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'health'],
            'permission_callback' => [self::class, 'permission'],
        ]);
        register_rest_route(self::NAMESPACE, '/catalog', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'catalog'],
            'permission_callback' => [self::class, 'permission'],
            'args' => [
                'category' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
                'page' => ['default' => 1, 'sanitize_callback' => 'absint'],
                'per_page' => ['default' => 50, 'sanitize_callback' => 'absint'],
                'search' => ['default' => '', 'sanitize_callback' => 'sanitize_text_field'],
            ],
        ]);
        register_rest_route(self::NAMESPACE, '/item/(?P<id>\d+)', [
            'methods' => WP_REST_Server::READABLE,
            'callback' => [self::class, 'item'],
            'permission_callback' => [self::class, 'permission'],
            'args' => [
                'id' => ['required' => true, 'sanitize_callback' => 'absint'],
                'category' => ['required' => true, 'sanitize_callback' => 'sanitize_key'],
            ],
        ]);
    }

    public static function permission(WP_REST_Request $request): bool {
        if (!defined('NOVEFLIX_STREMIO_TOKEN') || NOVEFLIX_STREMIO_TOKEN === '') {
            return true;
        }
        return hash_equals((string) NOVEFLIX_STREMIO_TOKEN, (string) $request->get_header('x-noveflix-token'));
    }

    public static function health(): WP_REST_Response {
        $counts = [];
        foreach (array_keys(self::$categories) as $category) {
            $query = self::query_for_category($category, 1, 1, '');
            $counts[$category] = $query instanceof WP_Query ? (int) $query->found_posts : 0;
        }
        return new WP_REST_Response([
            'ok' => true,
            'version' => self::VERSION,
            'site' => home_url('/'),
            'counts' => $counts,
            'time' => current_time('mysql', true),
        ]);
    }

    public static function catalog(WP_REST_Request $request) {
        $category = sanitize_key((string) $request->get_param('category'));
        if (!isset(self::$categories[$category])) {
            return new WP_Error('invalid_category', 'Categoria inválida.', ['status' => 400]);
        }
        $page = max(1, (int) $request->get_param('page'));
        $per_page = min(100, max(1, (int) $request->get_param('per_page')));
        $search = sanitize_text_field((string) $request->get_param('search'));
        $cache_key = 'nfs_catalog_' . md5($category . '|' . $page . '|' . $per_page . '|' . $search);
        $cached = get_transient($cache_key);
        if (is_array($cached)) {
            return new WP_REST_Response($cached);
        }
        $query = self::query_for_category($category, $page, $per_page, $search);
        if (!$query instanceof WP_Query) {
            return new WP_Error('category_not_found', 'A categoria não foi encontrada no WordPress.', ['status' => 404]);
        }
        $items = [];
        foreach ($query->posts as $post) {
            if ($post instanceof WP_Post) {
                $items[] = self::post_summary($post, $category);
            }
        }
        $payload = [
            'items' => $items,
            'page' => $page,
            'per_page' => $per_page,
            'total' => (int) $query->found_posts,
            'total_pages' => (int) $query->max_num_pages,
            'has_more' => $page < (int) $query->max_num_pages,
        ];
        set_transient($cache_key, $payload, 5 * MINUTE_IN_SECONDS);
        return new WP_REST_Response($payload);
    }

    public static function item(WP_REST_Request $request) {
        $id = (int) $request->get_param('id');
        $category = sanitize_key((string) $request->get_param('category'));
        if (!isset(self::$categories[$category])) {
            return new WP_Error('invalid_category', 'Categoria inválida.', ['status' => 400]);
        }
        $cache_key = 'nfs_item_' . $category . '_' . $id;
        $cached = get_transient($cache_key);
        if (is_array($cached)) {
            return new WP_REST_Response($cached);
        }
        $post = get_post($id);
        if (!$post instanceof WP_Post || $post->post_status !== 'publish') {
            return new WP_Error('not_found', 'Conteúdo não encontrado.', ['status' => 404]);
        }
        $payload = self::post_detail($post, $category);
        set_transient($cache_key, $payload, 10 * MINUTE_IN_SECONDS);
        return new WP_REST_Response($payload);
    }

    private static function query_for_category(string $category, int $page, int $per_page, string $search) {
        $tax_query = self::taxonomy_query($category);
        if (!$tax_query) {
            return null;
        }
        $post_types = get_post_types(['public' => true], 'names');
        unset($post_types['attachment']);
        return new WP_Query([
            'post_type' => array_values($post_types),
            'post_status' => 'publish',
            'posts_per_page' => $per_page,
            'paged' => $page,
            's' => $search,
            'orderby' => 'date',
            'order' => 'DESC',
            'ignore_sticky_posts' => true,
            'no_found_rows' => false,
            'tax_query' => $tax_query,
        ]);
    }

    private static function taxonomy_query(string $category): ?array {
        $clauses = ['relation' => 'OR'];
        foreach (get_taxonomies(['public' => true], 'names') as $taxonomy) {
            foreach (self::$categories[$category]['aliases'] as $slug) {
                $term = get_term_by('slug', $slug, $taxonomy);
                if ($term instanceof WP_Term) {
                    $clauses[] = [
                        'taxonomy' => $taxonomy,
                        'field' => 'term_id',
                        'terms' => [(int) $term->term_id],
                        'include_children' => true,
                    ];
                }
            }
        }
        return count($clauses) > 1 ? $clauses : null;
    }

    private static function post_summary(WP_Post $post, string $category): array {
        $settings = self::$categories[$category];
        $poster = get_the_post_thumbnail_url($post, 'full') ?: null;
        return [
            'id' => (int) $post->ID,
            'category' => $category,
            'type' => $settings['type'],
            'genre' => $settings['genre'],
            'episodic' => (bool) $settings['episodic'],
            'title' => self::clean_title(get_the_title($post)),
            'description' => self::description($post),
            'poster' => $poster,
            'background' => $poster,
            'year' => self::year($post),
            'url' => get_permalink($post),
            'modified_gmt' => get_post_modified_time('c', true, $post),
        ];
    }

    private static function post_detail(WP_Post $post, string $category): array {
        $summary = self::post_summary($post, $category);
        $sources = [
            'post_content_raw' => $post->post_content,
            'post_content_rendered' => apply_filters('the_content', $post->post_content),
            'post_excerpt' => $post->post_excerpt,
            'permalink' => get_permalink($post),
            'meta' => get_post_meta($post->ID),
        ];
        if (function_exists('get_fields')) {
            $acf = get_fields($post->ID);
            if (is_array($acf)) {
                $sources['acf'] = $acf;
            }
        }
        $players = self::extract_players($sources);
        $summary['players'] = $players;
        $summary['player_count'] = count($players);
        return $summary;
    }

    private static function extract_players($value, string $label = 'source'): array {
        $found = [];
        self::walk_value($value, $label, $found, 0);
        return array_values($found);
    }

    private static function walk_value($value, string $label, array &$found, int $depth): void {
        if ($depth > 12 || $value === null) return;
        if (is_array($value) || is_object($value)) {
            foreach ((array) $value as $key => $child) {
                self::walk_value($child, $label . '.' . (string) $key, $found, $depth + 1);
            }
            return;
        }
        if (!is_scalar($value)) return;
        $text = (string) $value;
        if ($text === '') return;
        $unserialized = maybe_unserialize($text);
        if ($unserialized !== $text) self::walk_value($unserialized, $label, $found, $depth + 1);
        $decoded_json = json_decode($text, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($decoded_json)) {
            self::walk_value($decoded_json, $label, $found, $depth + 1);
        }
        $normalized = html_entity_decode(wp_unslash($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $normalized = str_replace(['\\/', '\\u0026'], ['/', '&'], $normalized);
        preg_match_all('~https?://[^\s"\'<>\\]+~i', $normalized, $url_matches);
        foreach ($url_matches[0] ?? [] as $url) self::add_candidate($url, $label, $found);
        preg_match_all('/(?:src|href|data-src|data-url|file|url)\s*[:=]\s*["\']([^"\']+)["\']/i', $normalized, $attribute_matches);
        foreach ($attribute_matches[1] ?? [] as $url) self::add_candidate($url, $label, $found);
        preg_match_all('/[A-Za-z0-9+\/_-]{28,}={0,2}/', $normalized, $base64_matches);
        foreach ($base64_matches[0] ?? [] as $token) {
            $decoded = self::decode_base64_url($token);
            if ($decoded) self::add_candidate($decoded, $label . '.base64', $found);
        }
    }

    private static function add_candidate(string $raw, string $label, array &$found): void {
        $url = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'), " \t\n\r\0\x0B'\"),.;");
        if (strpos($url, '//') === 0) $url = 'https:' . $url;
        if (!preg_match('~^https?://~i', $url)) return;
        $host = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        $path = strtolower((string) wp_parse_url($url, PHP_URL_PATH));
        $is_media = preg_match('/\.(mp4|m3u8)$/i', $path) === 1;
        $is_player = preg_match('/(^|\.)painel\d*\.novefx\.biz$/i', $host) === 1
            || str_contains($host, 'esportesdavez.com')
            || str_contains($host, 'cdn-novflix.com');
        if (!$is_media && !$is_player) return;
        $found[md5($url)] = ['url' => esc_url_raw($url), 'label' => sanitize_text_field($label)];
    }

    private static function decode_base64_url(string $token): ?string {
        $token = strtr(rawurldecode($token), '-_', '+/');
        $token .= str_repeat('=', (4 - strlen($token) % 4) % 4);
        $decoded = base64_decode($token, true);
        if (!is_string($decoded) || $decoded === '') return null;
        $decoded = trim($decoded);
        if (preg_match('~^https?://~i', $decoded)) return $decoded;
        $json = json_decode($decoded, true);
        if (is_array($json)) {
            foreach (['safelink', 'second_safelink_url', 'url', 'src', 'file'] as $key) {
                if (!empty($json[$key]) && is_string($json[$key]) && preg_match('~^https?://~i', $json[$key])) return $json[$key];
            }
        }
        return null;
    }

    private static function clean_title(string $title): string {
        $title = preg_replace('/^Assistir\s+/iu', '', $title) ?: $title;
        $title = preg_replace('/\s+Online(?:\s+Grátis)?(?:\s+HD)?$/iu', '', $title) ?: $title;
        return trim(wp_strip_all_tags($title));
    }

    private static function description(WP_Post $post): string {
        $text = $post->post_excerpt ?: $post->post_content;
        $text = wp_strip_all_tags(strip_shortcodes($text));
        $text = preg_replace('/\s+/u', ' ', $text) ?: '';
        return wp_trim_words(trim($text), 55, '…');
    }

    private static function year(WP_Post $post): ?int {
        foreach (['ano', 'year', 'release_year', 'data_lancamento'] as $key) {
            $value = get_post_meta($post->ID, $key, true);
            if (preg_match('/(?:19|20)\d{2}/', (string) $value, $match)) return (int) $match[0];
        }
        $haystack = get_the_title($post) . ' ' . $post->post_excerpt . ' ' . $post->post_content;
        if (preg_match('/(?:19|20)\d{2}/', $haystack, $match)) return (int) $match[0];
        return (int) get_post_time('Y', true, $post);
    }

    public static function flush_post_cache($post_id): void {
        if (!is_numeric($post_id)) return;
        foreach (array_keys(self::$categories) as $category) {
            delete_transient('nfs_item_' . $category . '_' . (int) $post_id);
        }
        global $wpdb;
        if ($wpdb instanceof wpdb) {
            $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_nfs_catalog_%' OR option_name LIKE '_transient_timeout_nfs_catalog_%'");
        }
    }
}

NoveFlix_Stremio_Bridge::boot();
