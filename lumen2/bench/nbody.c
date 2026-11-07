// n-body: the Jovian planets around the Sun (nbody.lm in C).
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define PI 3.141592653589793
#define SOLAR_MASS (4 * PI * PI)
#define DAYS_PER_YEAR 365.24

typedef struct { double x, y, z, vx, vy, vz, mass; } body;

static body bodies[5] = {
  { 0, 0, 0, 0, 0, 0, SOLAR_MASS },
  { 4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
    1.66007664274403694e-03 * DAYS_PER_YEAR, 7.69901118419740425e-03 * DAYS_PER_YEAR, -6.90460016972063023e-05 * DAYS_PER_YEAR, 9.54791938424326609e-04 * SOLAR_MASS },
  { 8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
    -2.76742510726862411e-03 * DAYS_PER_YEAR, 4.99852801234917238e-03 * DAYS_PER_YEAR, 2.30417297573763929e-05 * DAYS_PER_YEAR, 2.85885980666130812e-04 * SOLAR_MASS },
  { 1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
    2.96460137564761618e-03 * DAYS_PER_YEAR, 2.37847173959480950e-03 * DAYS_PER_YEAR, -2.96589568540237556e-05 * DAYS_PER_YEAR, 4.36624404335156298e-05 * SOLAR_MASS },
  { 1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
    2.68067772490389322e-03 * DAYS_PER_YEAR, 1.62824170038242295e-03 * DAYS_PER_YEAR, -9.51592254519715870e-05 * DAYS_PER_YEAR, 5.15138902046611451e-05 * SOLAR_MASS },
};

static void offset(void) {
  double px = 0, py = 0, pz = 0;
  for (int k = 0; k < 5; k++) { px += bodies[k].vx * bodies[k].mass; py += bodies[k].vy * bodies[k].mass; pz += bodies[k].vz * bodies[k].mass; }
  bodies[0].vx = -px / SOLAR_MASS; bodies[0].vy = -py / SOLAR_MASS; bodies[0].vz = -pz / SOLAR_MASS;
}

static double energy(void) {
  double e = 0;
  for (int i = 0; i < 5; i++) {
    body *b = &bodies[i];
    e = e + 0.5 * b->mass * (b->vx * b->vx + b->vy * b->vy + b->vz * b->vz);
    for (int j = i + 1; j < 5; j++) {
      double dx = b->x - bodies[j].x, dy = b->y - bodies[j].y, dz = b->z - bodies[j].z;
      double d = sqrt(dx * dx + dy * dy + dz * dz);
      e = e - b->mass * bodies[j].mass / d;
    }
  }
  return e;
}

static void advance(double dt) {
  for (int i = 0; i < 4; i++) {
    for (int j = i + 1; j < 5; j++) {
      double dx = bodies[i].x - bodies[j].x, dy = bodies[i].y - bodies[j].y, dz = bodies[i].z - bodies[j].z;
      double d2 = dx * dx + dy * dy + dz * dz;
      double mag = dt / (d2 * sqrt(d2));
      double mi = bodies[i].mass, mj = bodies[j].mass;
      bodies[i].vx = bodies[i].vx - dx * mj * mag; bodies[i].vy = bodies[i].vy - dy * mj * mag; bodies[i].vz = bodies[i].vz - dz * mj * mag;
      bodies[j].vx = bodies[j].vx + dx * mi * mag; bodies[j].vy = bodies[j].vy + dy * mi * mag; bodies[j].vz = bodies[j].vz + dz * mi * mag;
    }
  }
  for (int k = 0; k < 5; k++) { bodies[k].x += dt * bodies[k].vx; bodies[k].y += dt * bodies[k].vy; bodies[k].z += dt * bodies[k].vz; }
}

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 1000;
  offset();
  printf("%.9f\n", energy());
  for (int i = 0; i < n; i++) advance(0.01);
  printf("%.9f\n", energy());
  return 0;
}
