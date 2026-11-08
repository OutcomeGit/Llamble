// Docker build check for the picture engine (stable-diffusion.cpp): load each ggml
// backend module next to sd-cli the way it does at runtime, say why any fails, and
// fail the build if there's no CPU device to fall back on.
#include <dirent.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef void *(*reg_fn)(void);
typedef size_t (*count_fn)(void *);
typedef int (*score_fn)(void);

int main(int argc, char **argv) {
    const char *dir = argc > 1 ? argv[1] : "/opt/sd";
    DIR *d = opendir(dir);
    if (!d) { perror(dir); return 2; }
    struct dirent *e;
    int cpu_ok = 0, modules = 0;
    while ((e = readdir(d))) {
        const char *n = e->d_name;
        if (strncmp(n, "libggml-", 8) || !strstr(n, ".so") || !strcmp(n, "libggml-base.so")) continue;
        char path[4096];
        snprintf(path, sizeof path, "%s/%s", dir, n);
        void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!h) { printf("  %-34s can't load: %s\n", n, dlerror()); continue; }
        void *init = dlsym(h, "ggml_backend_init");
        score_fn score = (score_fn)dlsym(h, "ggml_backend_score");
        if (!init) { printf("  %-34s (library, not a backend)\n", n); continue; }
        modules++;
        int s = score ? score() : -1;
        printf("  %-34s loaded, score %d\n", n, s);
        if (!strncmp(n, "libggml-cpu", 11) && s != 0) cpu_ok = 1;
    }
    closedir(d);
    printf("%d backend modules; CPU usable here: %s\n", modules, cpu_ok ? "yes" : "NO");
    return cpu_ok ? 0 : 1;
}
