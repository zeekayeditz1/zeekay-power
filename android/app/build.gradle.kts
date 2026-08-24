plugins {
    id("com.android.application")
}

// Injected only while producing the user's personal passwordless APK. The
// plaintext device credential must never be committed to this repository.
val zeekayAppToken = providers.environmentVariable("ZEEKAY_APP_TOKEN").orElse("").get()

android {
    namespace = "com.zeekayeditz.power"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.zeekayeditz.power"
        minSdk = 26
        targetSdk = 36
        versionCode = 4
        versionName = "1.2.0"
        buildConfigField("String", "APP_API_TOKEN", "\"$zeekayAppToken\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.webkit:webkit:1.17.0")
    implementation("androidx.work:work-runtime:2.11.2")
}
